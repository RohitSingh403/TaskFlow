import { createServer, type Server } from "node:http";
import { JobRecord, Project, WorkerRecord, evaluateAlerts } from "@taskflow/server";
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
  throw new Error("Timed out waiting for the alert condition");
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

it("opens a backlog alert once per cooldown, then failure, offline, and long-running alerts", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.alerts@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  const emails = queues.body.data.find((queue: { name: string }) => queue.name === "emails");

  const backlog = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "queue.backlog",
    name: "Email backlog",
    queue: "emails",
    threshold: 1,
    cooldownMs: 60_000,
  });
  expect(backlog.status).toBe(201);

  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${emails.id}/pause`)).send({});
  expect(paused.status).toBe(200);
  const waiting = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload: { to: "ops@example.com", subject: "Held", body: "Waiting behind a pause." },
  });
  expect(waiting.status).toBe(201);

  const first = await evaluateAlerts(new Date());
  expect(first).toHaveLength(1);
  expect(first[0]?.alertType).toBe("queue.backlog");
  const second = await evaluateAlerts(new Date());
  expect(second).toHaveLength(0);

  const history = await asAda(ada.get(`/api/v1/projects/${projectId}/alerts?status=open`));
  expect(history.status).toBe(200);
  expect(history.body.data).toHaveLength(1);
  const resolved = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/${history.body.data[0].id}/resolve`)).send({});
  expect(resolved.body.data.status).toBe("resolved");

  const failureRule = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "failure.rate",
    name: "Report failures",
    queue: "reports",
    threshold: 50,
    windowMs: 15 * 60 * 1000,
    minSamples: 1,
    cooldownMs: 60_000,
  });
  expect(failureRule.status).toBe(201);
  const failed = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "reports",
    name: "generate-report",
    maxAttempts: 1,
    payload: {
      reportType: "activity",
      format: "pdf",
      rangeDays: 1,
      _simulate: { failUntilAttempt: 1, errorMessage: "Renderer unavailable" },
    },
  });
  expect(failed.status).toBe(201);
  await waitFor(async () => {
    const current = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${failed.body.data.id}`));
    return current.body.data.status === "failed";
  });
  const failureAlerts = await evaluateAlerts(new Date());
  expect(failureAlerts.some((alert) => alert.alertType === "failure.rate")).toBe(true);

  const projectDoc = await Project.findOne({ publicId: projectId });
  expect(projectDoc).toBeTruthy();
  await WorkerRecord.create({
    workerId: "wrk_alert_offline",
    hostname: "old-host",
    pid: 1,
    assignments: [{
      projectId: projectDoc!._id,
      projectPublicId: projectId,
      queuePublicId: emails.id,
      queueName: "emails",
      bullQueueName: emails.bullQueueName ?? `tf_${projectId}_emails`,
      concurrency: 1,
    }],
    lastHeartbeatAt: new Date(Date.now() - 120_000),
    startedAt: new Date(Date.now() - 120_000),
  });
  const offlineRule = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "worker.offline",
    name: "Offline workers",
    cooldownMs: 60_000,
  });
  expect(offlineRule.status).toBe(201);

  await JobRecord.updateOne(
    { publicId: failed.body.data.id },
    { $set: { status: "active", startedAt: new Date(Date.now() - 120_000) } },
  );
  const slowRule = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "job.long_running",
    name: "Slow reports",
    queue: "reports",
    threshold: 10_000,
    cooldownMs: 60_000,
  });
  expect(slowRule.status).toBe(201);

  const rest = await evaluateAlerts(new Date());
  expect(rest.map((alert) => alert.alertType).sort()).toEqual(["job.long_running", "worker.offline"]);

  const other = request.agent(server);
  const outsider = await other.post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.alerts@example.com",
    password,
  });
  expect(outsider.status).toBe(201);
  const hidden = await other
    .get(`/api/v1/projects/${projectId}/alerts`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
