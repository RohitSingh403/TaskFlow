import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Schedule } from "@taskflow/server";
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the scheduled job");
}

let server: Server;
let stopWorker: (() => Promise<void>) | undefined;
let disconnect: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const { createApp } = await import("../apps/api/src/app.ts");
  const { connectInfrastructure, disconnectInfrastructure } = await import("../apps/api/src/infrastructure.ts");
  const { prepareAuth } = await import("../apps/api/src/modules/auth/auth.service.ts");
  const { attachSocket } = await import("../apps/api/src/socket.ts");
  const { startWorkerRuntime } = await import("../apps/worker/src/runtime.ts");

  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5_000 });
  await mongoose.connection.dropDatabase();
  await connectInfrastructure();
  await prepareAuth();

  const app = createApp();
  server = createServer(app);
  const io = attachSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const runtime = await startWorkerRuntime({
    mongoUri: process.env.MONGODB_URI!,
    redisUrl: process.env.REDIS_URL!,
    bullPrefix: process.env.BULL_PREFIX!,
    pollMs: 400,
    lockDurationMs: 5_000,
    stalledIntervalMs: 2_000,
  });
  stopWorker = async () => runtime.stop();
  disconnect = async () => {
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectInfrastructure();
  };
}, 40_000);

afterAll(async () => {
  await stopWorker?.();
  await disconnect?.();
});

it("creates a cron schedule, produces one occurrence, and skips a paused schedule", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.schedules@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;

  const project = await ada
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Reports", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const invalid = await ada
    .post(`/api/v1/projects/${projectId}/schedules`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Broken",
      queue: "reports",
      handler: "generate-report",
      cron: "* * * * * *",
      payload: { reportType: "sales", format: "pdf", rangeDays: 7 },
    });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("INVALID_SCHEDULE");

  const created = await ada
    .post(`/api/v1/projects/${projectId}/schedules`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Morning report",
      queue: "reports",
      handler: "generate-report",
      cron: "0 9 * * *",
      timeZone: "UTC",
      payload: { reportType: "sales", format: "pdf", rangeDays: 7 },
    });
  expect(created.status).toBe(201);
  expect(created.body.data.status).toBe("active");
  expect(created.body.data.nextRunAt).toBeTruthy();
  const scheduleId = created.body.data.id as string;

  await Schedule.updateOne({ publicId: scheduleId }, { nextRunAt: new Date(Date.now() - 1000) });
  const { produceDueSchedules } = await import("@taskflow/server");
  const first = await produceDueSchedules(new Date());
  const second = await produceDueSchedules(new Date());
  expect(first.produced).toBe(1);
  expect(second.produced).toBe(0);

  const listed = await ada.get(`/api/v1/projects/${projectId}/jobs?schedule=${scheduleId}`).set("Authorization", `Bearer ${token}`);
  expect(listed.status).toBe(200);
  expect(listed.body.data).toHaveLength(1);
  const jobId = listed.body.data[0].id as string;
  expect(listed.body.data[0].createdBy.type).toBe("system");

  await waitFor(async () => {
    const job = await ada.get(`/api/v1/projects/${projectId}/jobs/${jobId}`).set("Authorization", `Bearer ${token}`);
    return job.body.data?.status === "completed";
  });

  const paused = await ada.post(`/api/v1/projects/${projectId}/schedules/${scheduleId}/pause`).set("Authorization", `Bearer ${token}`);
  expect(paused.status).toBe(200);
  await Schedule.updateOne({ publicId: scheduleId }, { nextRunAt: new Date(Date.now() - 1000) });
  const whilePaused = await produceDueSchedules(new Date());
  expect(whilePaused.produced).toBe(0);

  const grace = request.agent(server);
  const other = await grace.post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.schedules@example.com",
    password,
  });
  const hidden = await grace
    .get(`/api/v1/projects/${projectId}/schedules/${scheduleId}`)
    .set("Authorization", `Bearer ${other.body.data.accessToken}`);
  expect(hidden.status).toBe(404);

  const production = await ada
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Billing", environment: "production" });
  const simulated = await ada
    .post(`/api/v1/projects/${production.body.data.id}/schedules`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Simulated",
      queue: "reports",
      handler: "generate-report",
      cron: "0 9 * * *",
      payload: { reportType: "sales", format: "pdf", rangeDays: 7, _simulate: { failUntilAttempt: 1 } },
    });
  expect(simulated.status).toBe(400);
  expect(simulated.body.error.code).toBe("SIMULATION_DISABLED");
}, 40_000);
