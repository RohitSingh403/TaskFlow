import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { JobRecord } from "@taskflow/server";
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

it("gives the oldest queued jobs a new delay and keeps their ids", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.reschedule@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Reschedule", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function submit(queue: string, extra: Record<string, unknown> = {}) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: queue === "reports" ? "generate-report" : "send-email",
      payload: queue === "reports" ? { reportType: "sales", format: "pdf", rangeDays: 7 } : payload,
      ...extra,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; status: string; queue: string; delayMs: number; idempotencyKey: string | null };
  }

  const waiting = await submit("emails", { idempotencyKey: "welcome-now" });
  const delayed = await submit("emails", { delayMs: 60_000, idempotencyKey: "welcome-later" });
  const step = await submit("emails");
  await JobRecord.collection.updateOne({ publicId: step.id }, { $set: { workflowRunId: "wfr_reschedule_step" } });
  const other = await submit("reports", { delayMs: 60_000 });
  expect(waiting.status).toBe("waiting");
  expect(delayed.status).toBe("delayed");

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ queue: "missing-queue", delayMs: 120_000 });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("QUEUE_NOT_FOUND");
  const negative = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ delayMs: -1 });
  expect(negative.status).toBe(400);
  expect(negative.body.error.code).toBe("VALIDATION_ERROR");
  const tooLong = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ delayMs: 30 * 24 * 60 * 60 * 1000 + 1 });
  expect(tooLong.status).toBe(400);
  expect(tooLong.body.error.code).toBe("VALIDATION_ERROR");

  const limited = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ queue: "emails", delayMs: 120_000, limit: 1 });
  expect(limited.status).toBe(200);
  expect(limited.body.data).toEqual({ rescheduled: 1, skipped: 0, jobIds: [waiting.id] });
  const held = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${waiting.id}`));
  expect(held.body.data.id).toBe(waiting.id);
  expect(held.body.data.status).toBe("delayed");
  expect(held.body.data.delayMs).toBe(120_000);
  expect(held.body.data.idempotencyKey).toBe("welcome-now");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayed.id}`))).body.data.delayMs).toBe(60_000);
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${step.id}`))).body.data.status).toBe("waiting");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.delayMs).toBe(60_000);

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
  await expect(reading.jobs.rescheduleQueued({ queue: "emails", delayMs: 120_000 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const rest = await writing.jobs.rescheduleQueued({ queue: "emails", delayMs: 120_000, limit: 20 });
  expect(rest.data.rescheduled).toBe(2);
  expect(rest.data.skipped).toBe(1);
  expect(rest.data.jobIds).toEqual([waiting.id, delayed.id]);
  const kept = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayed.id}`));
  expect(kept.body.data.status).toBe("delayed");
  expect(kept.body.data.delayMs).toBe(120_000);
  expect(kept.body.data.idempotencyKey).toBe("welcome-later");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${step.id}`))).body.data.status).toBe("waiting");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.queue).toBe("reports");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.delayMs).toBe(60_000);

  const cleared = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ queue: "emails", delayMs: 0, limit: 1 });
  expect(cleared.status).toBe(200);
  expect(cleared.body.data).toEqual({ rescheduled: 1, skipped: 0, jobIds: [waiting.id] });
  const released = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${waiting.id}`));
  expect(released.body.data.status).toBe("waiting");
  expect(released.body.data.delayMs).toBe(0);
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayed.id}`))).body.data.delayMs).toBe(120_000);

  const zero = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ delayMs: 0, limit: 0 });
  expect(zero.status).toBe(400);
  expect(zero.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/reschedule`)).send({ delayMs: 0, limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.reschedule@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/reschedule`)
    .send({ delayMs: 1_000, limit: 1 })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
