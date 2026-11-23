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
const payload = { reportType: "sales", format: "pdf", rangeDays: 7 };

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

it("resumes the oldest paused schedules and moves a past next run forward", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.resume-schedules@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Reports", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
      name,
      queue: "reports",
      handler: "generate-report",
      cron: "0 9 * * *",
      timeZone: "UTC",
      payload,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; nextRunAt: string; paused: boolean };
  }

  const oldest = await create("Morning report");
  const later = await create("Evening report");
  const running = await create("Hourly report");
  const removed = await create("Retired report");
  for (const schedule of [oldest, later, removed]) {
    const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/${schedule.id}/pause`));
    expect(paused.status).toBe(200);
  }
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/schedules/${removed.id}`));
  expect(deleted.status).toBe(200);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await Schedule.collection.updateOne({ publicId: oldest.id }, { $set: { nextRunAt: past } });

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/resume`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/resume`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/resume`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ resumed: 1, scheduleIds: [oldest.id] });
  const oldestAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${oldest.id}`));
  expect(oldestAfter.status).toBe(200);
  expect(oldestAfter.body.data.paused).toBe(false);
  expect(oldestAfter.body.data.nextRunAt).not.toBe(past.toISOString());
  expect(new Date(oldestAfter.body.data.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1_000);
  const laterStill = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${later.id}`));
  expect(laterStill.body.data.paused).toBe(true);
  expect(laterStill.body.data.nextRunAt).toBe(later.nextRunAt);
  const runningStill = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${running.id}`));
  expect(runningStill.body.data.paused).toBe(false);
  expect(runningStill.body.data.nextRunAt).toBe(running.nextRunAt);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/resume`)
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
  const second = await client.schedules.resumeSchedules({ limit: 20 });
  expect(second.data).toEqual({ resumed: 1, scheduleIds: [later.id] });
  const laterAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${later.id}`));
  expect(laterAfter.body.data.paused).toBe(false);
  expect(laterAfter.body.data.nextRunAt).toBe(later.nextRunAt);
  const removedAfter = await Schedule.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.paused).toBe(true);

  const again = await client.schedules.resumeSchedules({ limit: 20 });
  expect(again.data).toEqual({ resumed: 0, scheduleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.resume-schedules@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/resume`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
