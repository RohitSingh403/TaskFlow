import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { JobRecord, getBullQueue } from "@taskflow/server";
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

it("deletes an empty queue and keeps one that still has work or a schedule", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.queue@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Queues", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:write", "jobs:read", "queues:write", "queues:read"],
  });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });

  const created = await client.queues.create({ name: "image-resize", concurrency: 2 });
  const removed = await client.queues.delete(created.data.id);
  expect(removed.data).toEqual({ id: created.data.id, deleted: true });
  const listed = await client.queues.list();
  expect(listed.data.map((queue) => queue.name)).not.toContain("image-resize");
  const missing = await asAda(ada.get(`/api/v1/projects/${projectId}/queues/${created.data.id}`));
  expect(missing.status).toBe(404);

  const again = await client.queues.create({ name: "image-resize" });
  const paused = await client.queues.pause(again.data.id);
  expect(paused.data.isPaused).toBe(true);
  const held = await client.jobs.create({
    queue: "image-resize",
    name: "send-email",
    payload: { to: "user@example.com", subject: "Resize", body: "Hello" },
  });
  const blocked = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${again.data.id}`));
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("QUEUE_NOT_EMPTY");

  const stored = await JobRecord.findOne({ publicId: held.data.id });
  if (!stored) throw new Error("Held job was not recorded");
  const bullJob = await getBullQueue(stored.bullQueueName).getJob(stored.publicId);
  await bullJob?.remove();
  stored.status = "failed";
  stored.error = { message: "Provider timed out", stack: null, code: null };
  stored.completedAt = new Date();
  await stored.save();
  const cleared = await client.queues.delete(again.data.id);
  expect(cleared.data.deleted).toBe(true);
  const history = await client.jobs.get(held.data.id);
  expect(history.data.id).toBe(held.data.id);
  expect(history.data.status).toBe("failed");

  const schedule = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
    name: "Morning report",
    queue: "reports",
    handler: "generate-report",
    cron: "0 9 * * *",
    timeZone: "UTC",
    payload: { reportType: "activity", format: "pdf", rangeDays: 7 },
  });
  expect(schedule.status).toBe(201);
  const reports = listed.data.find((queue) => queue.name === "reports");
  if (!reports) throw new Error("Reports queue was not created");
  const scheduled = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${reports.id}`));
  expect(scheduled.status).toBe(409);
  expect(scheduled.body.error.code).toBe("QUEUE_IN_USE");

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
  const emails = listed.data.find((queue) => queue.name === "emails");
  if (!emails) throw new Error("Emails queue was not created");
  const used = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${emails.id}`));
  expect(used.status).toBe(409);
  expect(used.body.error.code).toBe("QUEUE_IN_USE");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.queue@example.com",
    password,
  });
  const hidden = await request(server)
    .delete(`/api/v1/projects/${projectId}/queues/${emails.id}`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
