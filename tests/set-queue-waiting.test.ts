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

it("sets the waiting ceiling on the oldest queues, including a paused queue that still has a job, and leaves a matching or deleted queue alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.set-waiting@example.com",
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
  const notifications = byName.get("notifications");
  if (!notifications) throw new Error("Default queues were not created");

  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${notifications}/pause`));
  expect(paused.status).toBe(200);
  const archive = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "archive", maxWaiting: 5000 });
  expect(archive.status).toBe(201);
  const holding = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "holding", maxWaiting: 2000 });
  expect(holding.status).toBe(201);
  const held = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "holding",
    name: "send-email",
    delayMs: 60_000,
    payload: { to: "user@example.com", subject: "Hold", body: "Hello" },
  });
  expect(held.status).toBe(201);
  const gone = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({ name: "gone", maxWaiting: 3000 });
  expect(gone.status).toBe(201);
  const removed = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${gone.body.data.id}`));
  expect(removed.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/max-waiting`)).send({ maxWaiting: 5000, limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/max-waiting`)).send({ maxWaiting: 5000, limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const tooLow = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/max-waiting`)).send({ maxWaiting: 0, limit: 1 });
  expect(tooLow.status).toBe(400);
  expect(tooLow.body.error.code).toBe("VALIDATION_ERROR");
  const tooHigh = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/max-waiting`)).send({ maxWaiting: 100_001, limit: 1 });
  expect(tooHigh.status).toBe(400);
  expect(tooHigh.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["queues:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["queues:read", "queues:write", "jobs:read"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.queues.setMaxWaiting({ maxWaiting: 5000, limit: 1 })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

  const present = await QueueConfig.find({ projectPublicId: projectId, deletedAt: null }).sort({ createdAt: 1 });
  const earliest = Math.min(...present.map((queue) => queue.createdAt.getTime()));
  const eligible = present.filter((queue) => queue.createdAt.getTime() === earliest && queue.maxWaiting !== 5000);
  if (eligible.length === 0) throw new Error("The oldest queue already had the target ceiling");
  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.queues.setMaxWaiting({ maxWaiting: 5000, limit: 1 });
  expect(first.data.updated).toBe(1);
  expect(first.data.skipped).toBe(0);
  const updatedId = first.data.queueIds[0];
  expect(eligible.map((queue) => queue.publicId)).toContain(updatedId);
  const oldest = present.find((queue) => queue.publicId === updatedId);
  const storedOldest = await QueueConfig.findOne({ publicId: updatedId });
  expect(storedOldest?.maxWaiting).toBe(5000);
  expect(storedOldest?.concurrency).toBe(oldest?.concurrency);
  expect(storedOldest?.name).toBe(oldest?.name);
  expect(storedOldest?.description).toBe(oldest?.description);
  expect(storedOldest?.isPaused).toBe(oldest?.isPaused);
  expect(storedOldest?.rateLimit ?? null).toBeNull();
  expect(storedOldest?.deletedAt).toBeUndefined();

  const changed = present.filter((queue) => queue.publicId !== updatedId && queue.maxWaiting !== 5000).map((queue) => queue.publicId);
  const skipped = present.filter((queue) => queue.publicId === updatedId || queue.maxWaiting === 5000);
  const second = await writing.queues.setMaxWaiting({ maxWaiting: 5000, limit: 20 });
  expect(second.data.updated).toBe(changed.length);
  expect(second.data.skipped).toBe(skipped.length);
  expect([...second.data.queueIds].sort()).toEqual([...changed].sort());

  const storedNotes = await QueueConfig.findOne({ publicId: notifications });
  expect(storedNotes?.maxWaiting).toBe(5000);
  expect(storedNotes?.isPaused).toBe(true);
  expect(storedNotes?.concurrency).toBe(10);
  expect(storedNotes?.name).toBe("notifications");
  expect(storedNotes?.deletedAt).toBeUndefined();
  const storedHolding = await QueueConfig.findOne({ publicId: holding.body.data.id });
  expect(storedHolding?.maxWaiting).toBe(5000);
  expect(storedHolding?.name).toBe("holding");
  expect(storedHolding?.isPaused).toBe(false);
  const jobs = await writing.jobs.list({ queue: "holding", limit: 10 });
  expect(jobs.data.map((job) => job.id)).toContain(held.body.data.id);
  const storedArchive = await QueueConfig.findOne({ publicId: archive.body.data.id });
  expect(storedArchive?.maxWaiting).toBe(5000);
  expect(storedArchive?.name).toBe("archive");
  expect(storedArchive?.deletedAt).toBeUndefined();
  const storedGone = await QueueConfig.findOne({ publicId: gone.body.data.id });
  expect(storedGone?.deletedAt).toBeInstanceOf(Date);
  expect(storedGone?.maxWaiting).toBe(3000);
  expect(storedGone?.name).toBe("gone");

  const again = await writing.queues.setMaxWaiting({ maxWaiting: 5000, limit: 20 });
  expect(again.data).toEqual({ updated: 0, skipped: present.length, queueIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.set-waiting@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/queues/max-waiting`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ maxWaiting: 5000, limit: 1 });
  expect(hidden.status).toBe(404);
});
