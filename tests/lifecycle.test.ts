import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRedis, Project } from "@taskflow/server";
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
  throw new Error("Timed out waiting for the expected job state");
}

let server: Server;
let base: request.Agent;
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
  const redis = createRedis(process.env.REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
  await prepareAuth();

  const app = createApp();
  server = createServer(app);
  const io = attachSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  base = request(`http://127.0.0.1:${address.port}`);

  const runtime = await startWorkerRuntime({
    mongoUri: process.env.MONGODB_URI!,
    redisUrl: process.env.REDIS_URL!,
    bullPrefix: process.env.BULL_PREFIX!,
    pollMs: 400,
    lockDurationMs: 5_000,
    stalledIntervalMs: 2_000,
  });
  stopWorker = async () => {
    await runtime.stop();
  };
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

it("runs the job lifecycle, retries, deduplicates, and isolates projects", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  expect(registered.body.data.user.email).toBe("ada@example.com");
  const token = registered.body.data.accessToken as string;

  const refreshed = await ada.post("/api/v1/auth/refresh");
  expect(refreshed.status).toBe(200);
  const [parallelA, parallelB] = await Promise.all([ada.post("/api/v1/auth/refresh"), ada.post("/api/v1/auth/refresh")]);
  expect(parallelA.status).toBe(200);
  expect(parallelB.status).toBe(200);
  expect(parallelA.body.data.accessToken).toBe(parallelB.body.data.accessToken);
  const rotated = (parallelA.headers["set-cookie"] as string[]).find((item) => item.startsWith("tf_refresh="));
  const rotatedAgain = await request(server).post("/api/v1/auth/refresh").set("Cookie", rotated!.split(";")[0]!);
  expect(rotatedAgain.status).toBe(200);
  ada.set("Cookie", rotated!.split(";")[0]!);
  const sessionToken = rotatedAgain.body.data.accessToken as string;

  const projectResponse = await ada
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${sessionToken}`)
    .send({ name: "Checkout", description: "Order side effects", environment: "development" });
  expect(projectResponse.status).toBe(201);
  const projectId = projectResponse.body.data.id as string;

  const queues = await ada.get(`/api/v1/projects/${projectId}/queues`).set("Authorization", `Bearer ${sessionToken}`);
  expect(queues.status).toBe(200);
  expect(queues.body.data.map((queue: { name: string }) => queue.name).sort()).toEqual([
    "emails",
    "notifications",
    "reports",
  ]);

  const keyResponse = await ada
    .post(`/api/v1/projects/${projectId}/api-keys`)
    .set("Authorization", `Bearer ${sessionToken}`)
    .send({ name: "Orders", scopes: ["jobs:read", "jobs:write", "queues:read"] });
  expect(keyResponse.status).toBe(201);
  const secret = keyResponse.body.data.secret as string;
  expect(secret.startsWith("tf_live_")).toBe(true);
  expect(keyResponse.body.data.prefix.length).toBeGreaterThan(8);

  const listedKeys = await ada.get(`/api/v1/projects/${projectId}/api-keys`).set("Authorization", `Bearer ${sessionToken}`);
  expect(JSON.stringify(listedKeys.body)).not.toContain(secret);

  const payload = {
    to: "user@example.com",
    subject: "Welcome",
    body: "Glad you are here.",
    userId: "user_123",
  };
  const submitted = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .set("Idempotency-Key", "welcome-user-123")
    .send({ queue: "emails", name: "send-email", payload });
  expect(submitted.status).toBe(201);
  const jobId = submitted.body.data.id as string;
  expect(submitted.body.data.status).toMatch(/waiting|delayed|active/);

  const replay = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .set("Idempotency-Key", "welcome-user-123")
    .send({ queue: "emails", name: "send-email", payload });
  expect(replay.status).toBe(200);
  expect(replay.body.data.id).toBe(jobId);
  expect(replay.body.data.duplicate).toBe(true);

  const conflict = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .set("Idempotency-Key", "welcome-user-123")
    .send({ queue: "emails", name: "send-email", payload: { ...payload, subject: "Different" } });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

  await waitFor(async () => {
    const current = await base.get(`/api/v1/projects/${projectId}/jobs/${jobId}`).set("Authorization", `Bearer ${secret}`);
    return current.body.data?.status === "completed";
  });
  const completed = await base.get(`/api/v1/projects/${projectId}/jobs/${jobId}`).set("Authorization", `Bearer ${secret}`);
  expect(completed.body.data.result.delivered).toBe(true);
  expect(completed.body.data.result.messageId).toMatch(/^msg_/);
  expect(completed.body.data.attemptsMade).toBeGreaterThanOrEqual(1);

  const attempts = await base.get(`/api/v1/projects/${projectId}/jobs/${jobId}/attempts`).set("Authorization", `Bearer ${secret}`);
  expect(attempts.body.data.length).toBeGreaterThanOrEqual(1);

  const failing = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .send({
      queue: "notifications",
      name: "send-notification",
      maxAttempts: 3,
      backoffType: "fixed",
      backoffDelayMs: 100,
      payload: {
        channel: "in-app",
        recipientId: "user_123",
        message: "Your report is ready.",
        _simulate: { failUntilAttempt: 1, errorMessage: "Provider timed out" },
      },
    });
  expect(failing.status).toBe(201);
  const failingId = failing.body.data.id as string;
  await waitFor(async () => {
    const current = await base.get(`/api/v1/projects/${projectId}/jobs/${failingId}`).set("Authorization", `Bearer ${secret}`);
    return current.body.data?.status === "completed";
  });
  const recovered = await base.get(`/api/v1/projects/${projectId}/jobs/${failingId}`).set("Authorization", `Bearer ${secret}`);
  expect(recovered.body.data.attemptsMade).toBeGreaterThanOrEqual(2);
  const failingAttempts = await base
    .get(`/api/v1/projects/${projectId}/jobs/${failingId}/attempts`)
    .set("Authorization", `Bearer ${secret}`);
  expect(failingAttempts.body.data.some((attempt: { status: string }) => attempt.status === "failed")).toBe(true);

  const emails = queues.body.data.find((queue: { name: string }) => queue.name === "emails");
  const paused = await ada
    .post(`/api/v1/projects/${projectId}/queues/${emails.id}/pause`)
    .set("Authorization", `Bearer ${sessionToken}`);
  expect(paused.status).toBe(200);
  expect(paused.body.data.status).toBe("paused");

  const denied = await base
    .post(`/api/v1/projects/${projectId}/queues/${emails.id}/resume`)
    .set("Authorization", `Bearer ${secret}`);
  expect(denied.status).toBe(403);

  const held = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .send({ queue: "emails", name: "send-email", payload: { ...payload, subject: "Held" } });
  expect(held.status).toBe(201);
  const heldId = held.body.data.id as string;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stillWaiting = await base.get(`/api/v1/projects/${projectId}/jobs/${heldId}`).set("Authorization", `Bearer ${secret}`);
  expect(["waiting", "delayed"]).toContain(stillWaiting.body.data.status);

  const resumed = await ada
    .post(`/api/v1/projects/${projectId}/queues/${emails.id}/resume`)
    .set("Authorization", `Bearer ${sessionToken}`);
  expect(resumed.status).toBe(200);
  await waitFor(async () => {
    const current = await base.get(`/api/v1/projects/${projectId}/jobs/${heldId}`).set("Authorization", `Bearer ${secret}`);
    return current.body.data?.status === "completed";
  });

  const delayed = await base
    .post(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${secret}`)
    .send({ queue: "reports", name: "generate-report", delayMs: 60_000, payload: { reportType: "sales", format: "pdf", rangeDays: 7 } });
  expect(delayed.status).toBe(201);
  expect(delayed.body.data.status).toBe("delayed");
  const cancelled = await base
    .post(`/api/v1/projects/${projectId}/jobs/${delayed.body.data.id}/cancel`)
    .set("Authorization", `Bearer ${secret}`);
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.data.status).toBe("cancelled");

  const grace = request.agent(server);
  const other = await grace.post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace@example.com",
    password,
  });
  const otherToken = other.body.data.accessToken as string;
  const forbidden = await grace.get(`/api/v1/projects/${projectId}/jobs/${jobId}`).set("Authorization", `Bearer ${otherToken}`);
  expect(forbidden.status).toBe(404);

  const production = await ada
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Billing", environment: "production" });
  const productionId = production.body.data.id as string;
  const simulated = await ada
    .post(`/api/v1/projects/${productionId}/jobs`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      queue: "emails",
      name: "send-email",
      payload: { ...payload, _simulate: { failUntilAttempt: 1 } },
    });
  expect(simulated.status).toBe(400);
  expect(simulated.body.error.code).toBe("SIMULATION_DISABLED");

  const project = await Project.findOne({ publicId: projectId });
  const { runHandler } = await import("../apps/worker/src/handlers.ts");
  const data = {
    publicId: "job_replay_case",
    projectObjectId: String(project!._id),
    projectPublicId: projectId,
    queueName: "emails",
    handler: "send-email",
    payload,
    timeoutMs: 5_000,
    traceId: "trace_test",
    allowSimulation: false,
  };
  const signal = new AbortController().signal;
  const first = await runHandler(data, 1, signal);
  const second = await runHandler(data, 2, signal);
  expect(first.messageId).toBe(second.messageId);
  expect(second.idempotentReplay).toBe(true);

  const overview = await ada
    .get(`/api/v1/projects/${projectId}/analytics/overview?range=24h`)
    .set("Authorization", `Bearer ${sessionToken}`);
  expect(overview.status).toBe(200);
  expect(overview.body.data.totals.completed).toBeGreaterThanOrEqual(2);
  expect(overview.body.data.workers.online).toBeGreaterThanOrEqual(1);

  const logs = await ada.get(`/api/v1/projects/${projectId}/logs?jobId=${jobId}`).set("Authorization", `Bearer ${sessionToken}`);
  expect(logs.status).toBe(200);
  expect(logs.body.data.length).toBeGreaterThan(0);
  expect(JSON.stringify(logs.body)).not.toContain(password);
}, 40_000);
