import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TaskFlow, TaskFlowError } from "./client.js";

let server: Server;
let port = 0;
const seen: { method: string; url: string; authorization: string; idempotency: string; body: string }[] = [];

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
