import { createHmac } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
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
process.env.WEBHOOK_BACKOFF_MS = "200";
process.env.WEBHOOK_MAX_ATTEMPTS = "2";

const password = "correcthorsebattery1";

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function signed(secret: string, raw: string, header: string | undefined) {
  const match = /^t=(\d+),v1=([a-f0-9]+)$/.exec(header ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(`${match[1]}.${raw}`).digest("hex");
  return expected === match[2];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the webhook");
}

let apiServer: HttpServer;
let receiver: HttpServer;
let receiverPort = 0;
let stopWorker: (() => Promise<void>) | undefined;
let disconnect: (() => Promise<void>) | undefined;
const received: { path: string; raw: string; signature: string; event: string; delivery: string }[] = [];
let failuresLeft = 1;

beforeAll(async () => {
  receiver = createHttpServer(async (req, res) => {
    const raw = await readBody(req);
    received.push({
      path: req.url ?? "",
      raw,
      signature: String(req.headers["taskflow-signature"] ?? ""),
      event: String(req.headers["taskflow-event"] ?? ""),
      delivery: String(req.headers["taskflow-delivery"] ?? ""),
    });
    if (req.url === "/retry" && failuresLeft > 0) {
      failuresLeft -= 1;
      res.writeHead(500);
      res.end("no");
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  receiverPort = (receiver.address() as { port: number }).port;

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
  apiServer = createHttpServer(app);
  const io = attachSocket(apiServer);
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
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
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await disconnectInfrastructure();
  };
}, 40_000);

afterAll(async () => {
  delete process.env.WEBHOOK_BACKOFF_MS;
  delete process.env.WEBHOOK_MAX_ATTEMPTS;
  await stopWorker?.();
  await disconnect?.();
});

it("delivers a signed job event, retries a failed endpoint, and rejects unsafe URLs", async () => {
  const ada = request.agent(apiServer);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.webhooks@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: "http://example.com/hook",
    events: ["job.completed"],
  });
  expect(blocked.status).toBe(400);
  expect(blocked.body.error.code).toBe("WEBHOOK_URL");

  const production = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks prod", environment: "production" });
  const productionId = production.body.data.id as string;
  const privateTarget = await asAda(ada.post(`/api/v1/projects/${productionId}/webhooks`)).send({
    url: "http://127.0.0.1:9/hook",
    events: ["job.completed"],
  });
  expect(privateTarget.status).toBe(400);

  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: `http://127.0.0.1:${receiverPort}/ok`,
    description: "Local receiver",
    events: ["job.completed"],
  });
  expect(created.status).toBe(201);
  const secret = created.body.data.secret as string;
  expect(secret.startsWith("whsec_")).toBe(true);
  expect(created.body.data.secretPrefix.endsWith("…")).toBe(true);

  const retryHook = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: `http://127.0.0.1:${receiverPort}/retry`,
    events: ["job.failed"],
  });
  expect(retryHook.status).toBe(201);

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain(secret);

  const outsider = await request(apiServer).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.webhooks@example.com",
    password,
  });
  const hidden = await request(apiServer)
    .get(`/api/v1/projects/${projectId}/webhooks`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);

  const submitted = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "reports",
    name: "generate-report",
    payload: { reportType: "sales", format: "pdf", rangeDays: 7 },
  });
  expect(submitted.status).toBe(201);

  const failed = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "reports",
    name: "generate-report",
    payload: { reportType: "sales", format: "pdf", rangeDays: 7, _simulate: { failUntilAttempt: 1 } },
    maxAttempts: 1,
  });
  expect(failed.status).toBe(201);

  await waitFor(async () => received.some((entry) => entry.path === "/ok" && entry.event === "job.completed"));
  const ok = received.find((entry) => entry.path === "/ok");
  expect(ok?.delivery.startsWith("whd_")).toBe(true);
  expect(signed(secret, ok!.raw, ok!.signature)).toBe(true);
  const payload = JSON.parse(ok!.raw) as { event: string; data: { jobId: string } };
  expect(payload.event).toBe("job.completed");
  expect(payload.data.jobId).toBe(submitted.body.data.id);

  await waitFor(async () => {
    const response = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
    const deliveries = response.body.data.deliveries as { event: string; status: string; attempts: unknown[] }[];
    return deliveries.some((delivery) => delivery.event === "job.failed" && delivery.status === "succeeded" && delivery.attempts.length === 2);
  });
});
