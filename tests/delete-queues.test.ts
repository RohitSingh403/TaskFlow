import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { QueueConfig } from "@taskflow/server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/taskflow_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379/1";
process.env.BULL_PREFIX = "taskflow_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-value";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-value";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.LOG_LEVEL = "error";

const password = "correcthorsebattery1";

let server: Server;
let disconnect: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const { createApp } = await import("../apps/api/src/app.ts");
  const { connectInfrastructure, disconnectInfrastructure } = await import("../apps/api/src/infrastructure.ts");
  const { prepareAuth } = await import("../apps/api/src/modules/auth/auth.service.ts");

  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5_000 });
  await mongoose.connection.dropDatabase();
  await connectInfrastructure();
  await prepareAuth();
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  disconnect = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectInfrastructure();
  };
}, 40_000);

afterAll(async () => {
  await disconnect?.();
});

it("deletes the oldest empty queues, including a paused one, and leaves a busy or in-use queue alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.delete-queues@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Queues", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  expect(listed.status).toBe(200);
  const byName = new Map((listed.body.data as { id: string; name: string }[]).map((queue) => [queue.name, queue.id]));
  const emails = byName.get("emails");
  const reports = byName.get("reports");
  const notifications = byName.get("notifications");
  if (!emails || !reports || !notifications) throw new Error("Default queues were not created");

  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${notifications}/pause`));
  expect(paused.status).toBe(200);
  const archive = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "archive", concurrency: 2 });
  expect(archive.status).toBe(201);
  const holding = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "holding" });
  expect(holding.status).toBe(201);
  const held = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "holding",
    name: "send-email",
    delayMs: 60_000,
    payload: { to: "user@example.com", subject: "Hold", body: "Hello" },
  });
  expect(held.status).toBe(201);
  const gone = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "gone" });
  expect(gone.status).toBe(201);
  const removed = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${gone.body.data.id}`));
  expect(removed.status).toBe(200);
  const schedule = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
    name: "Morning report",
    queue: "reports",
    handler: "generate-report",
    cron: "0 9 * * *",
    timeZone: "UTC",
    payload: { reportType: "activity", format: "pdf", rangeDays: 7 },
  });
  expect(schedule.status).toBe(201);
  const workflow = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Report then email",
    steps: [
      {
        key: "report",
        handler: "generate-report",
        queue: "reports",
        dependsOn: [],
        payload: { reportType: "activity", format: "pdf", rangeDays: 7 },
      },
      {
        key: "email",
        handler: "send-email",
        queue: "emails",
        dependsOn: ["report"],
        payload: { to: "ops@example.com", subject: "Activity report", body: "The activity report is ready." },
      },
    ],
  });
  expect(workflow.status).toBe(201);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/delete`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/delete`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["queues:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["queues:read", "queues:write"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.queues.deleteQueues({ limit: 1 })).rejects.toMatchObject({ status: 403 });

  const present = await QueueConfig.find({ projectPublicId: projectId, deletedAt: null }).sort({ createdAt: 1 });
  const blocked = new Set([emails, reports, holding.body.data.id as string]);
  const oldest = present[0];
  if (!oldest) throw new Error("No queues were present");
  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.queues.deleteQueues({ limit: 1 });
  if (blocked.has(oldest.publicId)) {
    expect(first.data).toEqual({ deleted: 0, skipped: 1, queueIds: [] });
  } else {
    expect(first.data).toEqual({ deleted: 1, skipped: 0, queueIds: [oldest.publicId] });
  }

  const deletable = present.filter((queue) => !blocked.has(queue.publicId)).map((queue) => queue.publicId);
  const kept = present.filter((queue) => blocked.has(queue.publicId)).map((queue) => queue.publicId);
  const second = await writing.queues.deleteQueues({ limit: 20 });
  const already = first.data.queueIds;
  expect(second.data).toEqual({
    deleted: deletable.filter((id) => !already.includes(id)).length,
    skipped: kept.length,
    queueIds: deletable.filter((id) => !already.includes(id)),
  });

  const storedNotes = await QueueConfig.findOne({ publicId: notifications });
  expect(storedNotes?.deletedAt).toBeInstanceOf(Date);
  expect(storedNotes?.isPaused).toBe(true);
  expect(storedNotes?.name).toBe("notifications");
  expect(storedNotes?.concurrency).toBe(10);
  const storedArchive = await QueueConfig.findOne({ publicId: archive.body.data.id });
  expect(storedArchive?.deletedAt).toBeInstanceOf(Date);
  expect(storedArchive?.name).toBe("archive");
  expect(storedArchive?.concurrency).toBe(2);
  await expect(writing.queues.get(notifications)).rejects.toMatchObject({ status: 404 });
  await expect(writing.queues.get(archive.body.data.id)).rejects.toMatchObject({ status: 404 });

  const remaining = await writing.queues.list();
  expect(remaining.data.map((queue) => queue.id).sort()).toEqual([emails, reports, holding.body.data.id].sort());
  const storedHeld = await QueueConfig.findOne({ publicId: holding.body.data.id });
  expect(storedHeld?.deletedAt).toBeUndefined();
  expect(storedHeld?.name).toBe("holding");
  const storedEmails = await QueueConfig.findOne({ publicId: emails });
  expect(storedEmails?.deletedAt).toBeUndefined();
  const storedReports = await QueueConfig.findOne({ publicId: reports });
  expect(storedReports?.deletedAt).toBeUndefined();

  const again = await writing.queues.deleteQueues({ limit: 20 });
  expect(again.data).toEqual({ deleted: 0, skipped: 3, queueIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.delete-queues@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/queues/delete`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
