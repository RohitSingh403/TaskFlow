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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the workflow");
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

it("runs a report before the email that depends on it, and keeps a failed dependency from completing the rest", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.workflows@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Workflows", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
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
  expect(created.status).toBe(201);
  expect(created.body.data.executionOrder).toEqual(["report", "email"]);
  const workflowId = created.body.data.id as string;

  const cycle = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Cycle",
    steps: [
      { key: "a", handler: "generate-report", queue: "reports", dependsOn: ["b"], payload: { reportType: "activity", format: "pdf", rangeDays: 1 } },
      { key: "b", handler: "send-email", queue: "emails", dependsOn: ["a"], payload: { to: "ops@example.com", subject: "Loop", body: "No" } },
    ],
  });
  expect(cycle.status).toBe(400);

  const shared = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Shared",
    steps: [
      { key: "a", handler: "generate-report", queue: "reports", dependsOn: [], payload: { reportType: "activity", format: "pdf", rangeDays: 1 } },
      { key: "b", handler: "send-email", queue: "emails", dependsOn: ["a"], payload: { to: "ops@example.com", subject: "One", body: "One" } },
      { key: "c", handler: "send-notification", queue: "notifications", dependsOn: ["a"], payload: { channel: "in-app", recipientId: "ops", message: "Two" } },
    ],
  });
  expect(shared.status).toBe(400);

  const started = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs`)).send({});
  expect(started.status).toBe(201);
  const runId = started.body.data.id as string;

  await waitFor(async () => {
    const current = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${runId}`));
    return current.body.data.status === "completed";
  });
  const finished = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${runId}`));
  const report = finished.body.data.steps.find((step: { key: string }) => step.key === "report");
  const email = finished.body.data.steps.find((step: { key: string }) => step.key === "email");
  expect(report.status).toBe("completed");
  expect(email.status).toBe("completed");
  expect(Date.parse(report.completedAt)).toBeLessThanOrEqual(Date.parse(email.startedAt));

  const other = request.agent(server);
  const outsider = await other.post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.workflows@example.com",
    password,
  });
  expect(outsider.status).toBe(201);
  const hidden = await other
    .get(`/api/v1/projects/${projectId}/workflows/${workflowId}`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);

  const settings = await asAda(ada.patch(`/api/v1/projects/${projectId}`)).send({
    defaultJobSettings: {
      maxAttempts: 1,
      backoffType: "exponential",
      backoffDelayMs: 1000,
      timeoutMs: 30000,
      priority: "medium",
    },
  });
  expect(settings.status).toBe(200);

  const fragile = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Fragile report",
    steps: [
      {
        key: "report",
        handler: "generate-report",
        queue: "reports",
        dependsOn: [],
        payload: {
          reportType: "activity",
          format: "pdf",
          rangeDays: 1,
          _simulate: { failUntilAttempt: 1, errorMessage: "Renderer unavailable" },
        },
      },
      {
        key: "email",
        handler: "send-email",
        queue: "emails",
        dependsOn: ["report"],
        payload: { to: "ops@example.com", subject: "Held", body: "This waits for the report." },
      },
    ],
  });
  expect(fragile.status).toBe(201);
  const fragileId = fragile.body.data.id as string;
  const failedStart = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${fragileId}/runs`)).send({});
  expect(failedStart.status).toBe(201);
  const failedRunId = failedStart.body.data.id as string;

  await waitFor(async () => {
    const current = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${fragileId}/runs/${failedRunId}`));
    const step = current.body.data.steps.find((item: { key: string }) => item.key === "report");
    return step.status === "failed";
  });
  const blocked = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${fragileId}/runs/${failedRunId}`));
  expect(blocked.body.data.status).toBe("failed");
  const blockedEmail = blocked.body.data.steps.find((step: { key: string }) => step.key === "email");
  expect(blockedEmail.status).not.toBe("completed");

  const reportJobId = blocked.body.data.steps.find((step: { key: string }) => step.key === "report").jobId as string;
  const retried = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${reportJobId}/retry`)).send({});
  expect(retried.status).toBe(200);

  await waitFor(async () => {
    const current = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${fragileId}/runs/${failedRunId}`));
    return current.body.data.status === "completed";
  });
}, 70_000);
