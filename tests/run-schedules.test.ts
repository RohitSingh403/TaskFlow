import { createServer, type Server } from "node:http";
import { Schedule } from "@taskflow/server";
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

it("queues one job for each of the oldest schedules and leaves the next run time unchanged", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.run-schedules@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Runs", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, queue: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
      name,
      queue,
      handler: "generate-report",
      cron: "0 9 * * *",
      timeZone: "UTC",
      payload: { reportType: "sales", format: "pdf", rangeDays: 7 },
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; nextRunAt: string; paused: boolean; lastJobId: string | null };
  }

  const oldest = await create("Morning report", "reports");
  const later = await create("Evening report", "emails");
  const held = await create("Held report", "notifications");
  const removed = await create("Removed report", "reports");
  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/${held.id}/pause`));
  expect(paused.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/schedules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/run`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/run`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/run`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data.queued).toBe(1);
  expect(first.body.data.skipped).toBe(0);
  expect(first.body.data.scheduleIds).toEqual([oldest.id]);
  expect(first.body.data.jobIds).toHaveLength(1);
  const oldestAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${oldest.id}`));
  expect(oldestAfter.body.data.nextRunAt).toBe(oldest.nextRunAt);
  expect(oldestAfter.body.data.paused).toBe(false);
  expect(oldestAfter.body.data.lastJobId).toBe(first.body.data.jobIds[0]);
  const laterStill = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${later.id}`));
  expect(laterStill.body.data.lastJobId).toBeNull();
  const heldStill = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${held.id}`));
  expect(heldStill.body.data.paused).toBe(true);
  expect(heldStill.body.data.lastJobId).toBeNull();
  const removedAfter = await Schedule.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/run`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write", "jobs:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const second = await client.schedules.runSchedules({ limit: 20 });
  expect(second.data.queued).toBe(3);
  expect(second.data.skipped).toBe(0);
  expect(second.data.scheduleIds).toEqual([oldest.id, later.id, held.id]);
  expect(new Set(second.data.jobIds).size).toBe(3);
  expect(second.data.jobIds).not.toContain(first.body.data.jobIds[0]);
  const oldestListed = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${oldest.id}`));
  expect(oldestListed.body.data.nextRunAt).toBe(oldest.nextRunAt);
  expect(oldestListed.body.data.lastJobId).toBe(second.data.jobIds[0]);
  const heldListed = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${held.id}`));
  expect(heldListed.body.data.paused).toBe(true);
  expect(heldListed.body.data.nextRunAt).toBe(held.nextRunAt);
  expect(heldListed.body.data.lastJobId).toBe(second.data.jobIds[2]);
  const removedStill = await Schedule.findOne({ publicId: removed.id });
  expect(removedStill?.deletedAt).toBeTruthy();

  const again = await client.schedules.runSchedules({ limit: 20 });
  expect(again.data.queued).toBe(3);
  expect(again.data.skipped).toBe(0);
  expect(again.data.scheduleIds).toEqual([oldest.id, later.id, held.id]);
  expect(again.data.jobIds.every((jobId) => !second.data.jobIds.includes(jobId))).toBe(true);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.run-schedules@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/run`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
