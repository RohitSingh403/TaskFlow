import { createServer, type Server } from "node:http";
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
const payload = { to: "user@example.com", subject: "Welcome", body: "Hello" };

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

it("runs the oldest delayed jobs now and keeps their ids", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.promote@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Promote", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function submit(queue: string, delayMs = 0, idempotencyKey?: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: queue === "reports" ? "generate-report" : "send-email",
      payload: queue === "reports" ? { reportType: "sales", format: "pdf", rangeDays: 7 } : payload,
      ...(delayMs ? { delayMs } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; status: string; delayMs: number; idempotencyKey: string | null };
  }

  const waiting = await submit("emails");
  const oldest = await submit("emails", 60_000, "welcome-later");
  const newer = await submit("emails", 120_000);
  const other = await submit("reports", 60_000);
  expect(waiting.status).toBe("waiting");
  expect(oldest.status).toBe("delayed");
  expect(oldest.idempotencyKey).toBe("welcome-later");

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)).send({ queue: "missing-queue" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("QUEUE_NOT_FOUND");

  const limited = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)).send({ queue: "emails", limit: 1 });
  expect(limited.status).toBe(200);
  expect(limited.body.data).toEqual({ promoted: 1, skipped: 0, jobIds: [oldest.id] });
  const promoted = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${oldest.id}`));
  expect(promoted.status).toBe(200);
  expect(promoted.body.data.id).toBe(oldest.id);
  expect(promoted.body.data.status).toBe("waiting");
  expect(promoted.body.data.delayMs).toBe(0);
  expect(promoted.body.data.idempotencyKey).toBe("welcome-later");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${newer.id}`))).body.data.status).toBe("delayed");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.status).toBe("delayed");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:read", "jobs:write"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.jobs.promoteDelayed({ queue: "emails" })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const rest = await writing.jobs.promoteDelayed({ queue: "emails", limit: 20 });
  expect(rest.data).toEqual({ promoted: 1, skipped: 0, jobIds: [newer.id] });
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${newer.id}`))).body.data.delayMs).toBe(0);
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${waiting.id}`))).body.data.id).toBe(waiting.id);
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.status).toBe("delayed");

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)).send({ queue: "emails", limit: 20 });
  expect(again.status).toBe(200);
  expect(again.body.data).toEqual({ promoted: 0, skipped: 0, jobIds: [] });

  const zero = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)).send({ limit: 0 });
  expect(zero.status).toBe(400);
  expect(zero.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.promote@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/promote-delayed`)
    .send({ limit: 1 })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
