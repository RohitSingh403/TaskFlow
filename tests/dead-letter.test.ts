import { createServer, type Server } from "node:http";
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
  throw new Error("Timed out waiting for a failed job");
}

let server: Server;
let stopWorker: (() => Promise<void>) | undefined;
let disconnect: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const { createApp } = await import("../apps/api/src/app.ts");
  const { connectInfrastructure, disconnectInfrastructure } = await import("../apps/api/src/infrastructure.ts");
  const { prepareAuth } = await import("../apps/api/src/modules/auth/auth.service.ts");
  const { startWorkerRuntime } = await import("../apps/worker/src/runtime.ts");

  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5_000 });
  await mongoose.connection.dropDatabase();
  await connectInfrastructure();
  await prepareAuth();
  const app = createApp();
  server = createServer(app);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectInfrastructure();
  };
}, 40_000);

afterAll(async () => {
  await stopWorker?.();
  await disconnect?.();
});

it("retries failed jobs on one queue and leaves the other queue failed", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.deadletter@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Dead letter", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const email = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload: { to: "user@example.com", subject: "Welcome", body: "Hello", _simulate: { failUntilAttempt: 1 } },
    maxAttempts: 1,
  });
  expect(email.status).toBe(201);
  const emailId = email.body.data.id as string;

  const report = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "reports",
    name: "generate-report",
    payload: { reportType: "sales", format: "pdf", rangeDays: 7, _simulate: { failUntilAttempt: 1 } },
    maxAttempts: 1,
  });
  expect(report.status).toBe(201);
  const reportId = report.body.data.id as string;

  await waitFor(async () => {
    const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs?status=failed`));
    return listed.body.data.length === 2;
  });

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/retry-failed`)).send({ queue: "missing-queue" });
  expect(missing.status).toBe(404);

  const retried = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/retry-failed`)).send({ queue: "emails", limit: 20 });
  expect(retried.status).toBe(200);
  expect(retried.body.data.retried).toBe(1);
  expect(retried.body.data.jobIds).toEqual([emailId]);

  const emailJob = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${emailId}`));
  expect(emailJob.body.data.status).not.toBe("failed");
  const reportJob = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${reportId}`));
  expect(reportJob.body.data.status).toBe("failed");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.deadletter@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/retry-failed`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({});
  expect(hidden.status).toBe(404);
});
