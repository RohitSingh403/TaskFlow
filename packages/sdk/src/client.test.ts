import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TaskFlow, TaskFlowError } from "./client.js";

let server: Server;
let port = 0;
const seen: { method: string; url: string; authorization: string; idempotency: string; body: string }[] = [];
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: String(req.headers.authorization ?? ""),
      idempotency: String(req.headers["idempotency-key"] ?? ""),
      body,
    });
    if (req.url === "/api/v1/projects") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [{ id: "proj_sdk", name: "SDK", environment: "development" }], meta: { requestId: "req_1" } }));
      return;
    }
    if (req.url === "/api/v1/projects/proj_sdk/jobs" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: { id: "job_1", status: "waiting", queue: "emails", name: "send-email", duplicate: false },
        meta: { requestId: "req_2" },
      }));
      return;
    }
    const key = `${req.method} ${req.url}`;
    hits[key] = (hits[key] ?? 0) + 1;
    if (req.url === "/api/v1/projects/proj_retry/jobs/job_flaky" && req.method === "GET") {
      if (hits[key] < 3) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ success: false, error: { code: "UNAVAILABLE", message: "busy" }, meta: {} }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { id: "job_flaky", status: "completed", result: { delivered: true } }, meta: {} }));
      return;
    }
    if (req.url === "/api/v1/projects/proj_retry/jobs" && req.method === "POST") {
      const hasKey = Boolean(req.headers["idempotency-key"]);
      if (hasKey && hits[key] < 2) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { code: "UNAVAILABLE", message: "busy" }, meta: {} }));
        return;
      }
      res.writeHead(hasKey ? 201 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(hasKey
        ? { success: true, data: { id: "job_retried", status: "waiting", duplicate: false }, meta: {} }
        : { success: false, error: { code: "UNAVAILABLE", message: "busy" }, meta: {} }));
      return;
    }
    if (req.url === "/api/v1/projects/proj_wait/jobs/job_slow" && req.method === "GET") {
      const status = hits[key] < 3 ? "waiting" : "completed";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { id: "job_slow", status, result: status === "completed" ? { delivered: true } : null }, meta: {} }));
      return;
    }
    if (req.url === "/api/v1/projects/proj_wait/jobs/job_stuck" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { id: "job_stuck", status: "waiting", result: null }, meta: {} }));
      return;
    }
    if (req.url === "/api/v1/projects/proj_wait/jobs/job_failed" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { id: "job_failed", status: "failed", error: { message: "no", stack: null, code: "FAILED" } }, meta: {} }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "API key was rejected" }, meta: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("resolves the API key's project and submits a job without waiting for it", async () => {
  const client = new TaskFlow({ apiKey: "tf_live_test", baseUrl: `http://127.0.0.1:${port}/api/v1` });
  const created = await client.jobs.create({
    queue: "emails",
    name: "send-email",
    payload: { userId: "user_123" },
    idempotencyKey: "welcome-user-123",
  });
  expect(created.data.id).toBe("job_1");
  expect(created.data.duplicate).toBe(false);
  expect(created.data.status).toBe("waiting");
  expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v1/projects", authorization: "Bearer tf_live_test" });
  expect(seen[1]).toMatchObject({
    method: "POST",
    url: "/api/v1/projects/proj_sdk/jobs",
    authorization: "Bearer tf_live_test",
    idempotency: "welcome-user-123",
  });
  expect(JSON.parse(seen[1]!.body)).toMatchObject({ queue: "emails", name: "send-email", payload: { userId: "user_123" } });
});

it("surfaces the API error code", async () => {
  const client = new TaskFlow({ apiKey: "tf_live_bad", baseUrl: `http://127.0.0.1:${port}/api/v1`, projectId: "proj_missing" });
  await expect(client.jobs.get("job_missing")).rejects.toMatchObject({
    name: "TaskFlowError",
    status: 401,
    code: "UNAUTHORIZED",
  });
  await expect(client.jobs.get("job_missing")).rejects.toBeInstanceOf(TaskFlowError);
});

it("retries a read and an idempotent create, and does not retry a create without a key", async () => {
  const client = new TaskFlow({
    apiKey: "tf_live_test",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    projectId: "proj_retry",
    retries: 2,
    retryDelayMs: 1,
  });
  const read = await client.jobs.get("job_flaky");
  expect(read.data.status).toBe("completed");
  expect(hits["GET /api/v1/projects/proj_retry/jobs/job_flaky"]).toBe(3);

  const created = await client.jobs.create({
    queue: "emails",
    name: "send-email",
    payload: { userId: "user_123" },
    idempotencyKey: "welcome-user-123",
  });
  expect(created.data.id).toBe("job_retried");
  expect(hits["POST /api/v1/projects/proj_retry/jobs"]).toBe(2);

  await expect(client.jobs.create({
    queue: "emails",
    name: "send-email",
    payload: { userId: "user_456" },
  })).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
  expect(hits["POST /api/v1/projects/proj_retry/jobs"]).toBe(3);
});

it("waits until a job finishes and times out when it stays waiting", async () => {
  const client = new TaskFlow({
    apiKey: "tf_live_test",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    projectId: "proj_wait",
    retryDelayMs: 1,
  });
  const finished = await client.jobs.wait("job_slow", { timeoutMs: 1_000, intervalMs: 20 });
  expect(finished.data.status).toBe("completed");
  expect(finished.data.result).toMatchObject({ delivered: true });

  const failed = await client.jobs.wait("job_failed", { timeoutMs: 500, intervalMs: 20 });
  expect(failed.data.status).toBe("failed");

  await expect(client.jobs.wait("job_stuck", { timeoutMs: 40, intervalMs: 15 })).rejects.toMatchObject({
    code: "JOB_WAIT_TIMEOUT",
    status: 0,
  });
});
