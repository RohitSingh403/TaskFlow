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

it("moves the oldest queued jobs to another queue and keeps their ids", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.move-queued@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Move", environment: "development" });
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
    return created.body.data as { id: string; status: string; queue: string; priority: string; delayMs: number; idempotencyKey: string | null };
  }

  const waiting = await submit("emails", { idempotencyKey: "welcome-now", priority: "high" });
  const delayed = await submit("emails", { delayMs: 60_000, idempotencyKey: "welcome-later", priority: "low" });
  const step = await submit("emails", { delayMs: 90_000 });
  await JobRecord.collection.updateOne({ publicId: step.id }, { $set: { workflowRunId: "wfr_move_step" } });
  const other = await submit("reports", { delayMs: 60_000 });
  const finished = await submit("emails");
  await JobRecord.collection.updateOne({ publicId: finished.id }, { $set: { status: "completed", completedAt: new Date() } });

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "missing-queue" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("QUEUE_NOT_FOUND");
  const missingFrom = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", from: "missing-queue" });
  expect(missingFrom.status).toBe(404);
  expect(missingFrom.body.error.code).toBe("QUEUE_NOT_FOUND");
  const same = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "emails", from: "emails" });
  expect(same.status).toBe(400);
  expect(same.body.error.code).toBe("VALIDATION_ERROR");

  const limited = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", from: "emails", limit: 1 });
  expect(limited.status).toBe(200);
  expect(limited.body.data).toEqual({ moved: 1, skipped: 0, jobIds: [waiting.id] });
  const movedWaiting = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${waiting.id}`));
  expect(movedWaiting.body.data.queue).toBe("reports");
  expect(movedWaiting.body.data.status).toBe("waiting");
  expect(movedWaiting.body.data.priority).toBe("high");
  expect(movedWaiting.body.data.idempotencyKey).toBe("welcome-now");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayed.id}`))).body.data.queue).toBe("emails");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${step.id}`))).body.data.queue).toBe("emails");

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
  await expect(reading.jobs.moveQueued({ queue: "reports", from: "emails" })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const rest = await writing.jobs.moveQueued({ queue: "reports", from: "emails", limit: 20 });
  expect(rest.data).toEqual({ moved: 1, skipped: 0, jobIds: [delayed.id] });
  const kept = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayed.id}`));
  expect(kept.body.data.queue).toBe("reports");
  expect(kept.body.data.status).toBe("delayed");
  expect(kept.body.data.delayMs).toBe(60_000);
  expect(kept.body.data.priority).toBe("low");
  expect(kept.body.data.idempotencyKey).toBe("welcome-later");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${step.id}`))).body.data.queue).toBe("emails");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${other.id}`))).body.data.queue).toBe("reports");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${finished.id}`))).body.data.status).toBe("completed");

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", from: "emails", limit: 20 });
  expect(again.status).toBe(200);
  expect(again.body.data).toEqual({ moved: 0, skipped: 0, jobIds: [] });

  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  const reports = (queues.body.data as { id: string; name: string }[]).find((queue) => queue.name === "reports");
  expect(reports).toBeTruthy();
  const capped = await asAda(ada.patch(`/api/v1/projects/${projectId}/queues/${reports!.id}`)).send({ maxWaiting: 1 });
  expect(capped.status).toBe(200);
  const blockedJob = await submit("emails", { delayMs: 30_000 });
  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", from: "emails", limit: 20 });
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe("QUEUE_BACKPRESSURE");
  expect((await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${blockedJob.id}`))).body.data.queue).toBe("emails");

  const zero = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", limit: 0 });
  expect(zero.status).toBe(400);
  expect(zero.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/move`)).send({ queue: "reports", limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.move-queued@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/move`)
    .send({ queue: "reports", limit: 1 })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
