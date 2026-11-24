import { createServer, type Server } from "node:http";
import { QueueConfig } from "@taskflow/server";
import { TaskFlow } from "@taskflow/sdk";
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

it("pauses the oldest running queues and leaves waiting jobs on them", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.pause-queues@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Imports", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  expect(listed.status).toBe(200);
  for (const queue of listed.body.data as { id: string }[]) {
    const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${queue.id}/pause`));
    expect(paused.status).toBe(200);
  }

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({
      name,
      description: `${name} queue`,
      concurrency: 4,
      maxWaiting: 1000,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; name: string; isPaused: boolean; concurrency: number };
  }

  const oldest = await create("imports");
  const later = await create("exports");
  const held = await create("holds");
  const removed = await create("retired");
  const heldPause = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${held.id}/pause`));
  expect(heldPause.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/queues/${removed.id}`));
  expect(deleted.status).toBe(200);
  await QueueConfig.collection.updateOne({ publicId: removed.id }, { $set: { isPaused: false } });

  const waiting = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "imports",
    name: "generate-report",
    payload: { reportType: "activity", format: "pdf", rangeDays: 7 },
    idempotencyKey: "imports-waiting",
  });
  expect(waiting.status).toBe(201);
  const jobId = waiting.body.data.id as string;

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/pause`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/pause`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/pause`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ paused: 1, skipped: 0, queueIds: [oldest.id] });
  const oldestAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/queues/${oldest.id}`));
  expect(oldestAfter.status).toBe(200);
  expect(oldestAfter.body.data.isPaused).toBe(true);
  expect(oldestAfter.body.data.name).toBe("imports");
  expect(oldestAfter.body.data.concurrency).toBe(4);
  expect(oldestAfter.body.data.stats.waiting).toBeGreaterThanOrEqual(1);
  const kept = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${jobId}`));
  expect(kept.status).toBe(200);
  expect(kept.body.data.id).toBe(jobId);
  expect(kept.body.data.status).toBe("waiting");
  expect(kept.body.data.queue).toBe("imports");
  const laterStill = await asAda(ada.get(`/api/v1/projects/${projectId}/queues/${later.id}`));
  expect(laterStill.body.data.isPaused).toBe(false);
  const heldStill = await asAda(ada.get(`/api/v1/projects/${projectId}/queues/${held.id}`));
  expect(heldStill.body.data.isPaused).toBe(true);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["queues:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/queues/pause`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["queues:write", "queues:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const second = await client.queues.pauseQueues({ limit: 20 });
  expect(second.data).toEqual({ paused: 1, skipped: 0, queueIds: [later.id] });
  const laterAfter = await client.queues.get(later.id);
  expect(laterAfter.data.isPaused).toBe(true);
  expect(laterAfter.data.id).toBe(later.id);
  const removedAfter = await QueueConfig.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.isPaused).toBe(false);

  const again = await client.queues.pauseQueues({ limit: 20 });
  expect(again.data).toEqual({ paused: 0, skipped: 0, queueIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.pause-queues@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/queues/pause`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);

  const single = await client.queues.pause(later.id);
  expect(single.data.id).toBe(later.id);
  expect(single.data.isPaused).toBe(true);
});
