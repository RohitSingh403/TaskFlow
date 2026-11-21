import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { getBullQueue, JobRecord } from "@taskflow/server";
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

it("moves a delayed job onto the queue and leaves every other job waiting", async () => {
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
  const delayed = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    priority: "high",
    delayMs: 60_000,
    idempotencyKey: "welcome-promote-once",
  });
  expect(delayed.status).toBe(201);
  const jobId = delayed.body.data.id as string;
  expect(delayed.body.data.status).toBe("delayed");
  await JobRecord.collection.updateOne(
    { publicId: jobId },
    { $set: { workflowRunId: "wfr_promote_source", scheduleId: "sch_promote_source" } },
  );

  const waiting = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(waiting.status).toBe(201);
  const waitingId = waiting.body.data.id as string;

  const before = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(before.status).toBe(200);

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
  await expect(reading.jobs.promote(jobId)).rejects.toMatchObject({ status: 403 });

  const tooSoon = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${waitingId}/promote`));
  expect(tooSoon.status).toBe(409);
  expect(tooSoon.body.error.code).toBe("JOB_NOT_DELAYED");

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const promoted = await writing.jobs.promote(jobId);
  expect(promoted.data.id).toBe(jobId);
  expect(promoted.data.status).toMatch(/waiting|active/);
  expect(promoted.data.delayMs).toBe(0);
  expect(promoted.data.idempotencyKey).toBe("welcome-promote-once");
  expect(promoted.data.scheduleId).toBe("sch_promote_source");

  const stored = await JobRecord.findOne({ publicId: jobId });
  expect(stored?.workflowRunId).toBe("wfr_promote_source");
  expect(stored?.scheduleId).toBe("sch_promote_source");
  const queue = getBullQueue(stored!.bullQueueName);
  const bullJob = await queue.getJob(jobId);
  expect(bullJob).toBeTruthy();
  expect(await bullJob!.getState()).toMatch(/waiting|prioritized|active|paused/);

  const again = await writing.jobs.promote(jobId).catch((error: unknown) => error);
  expect(again).toMatchObject({ status: 409, code: "JOB_NOT_DELAYED" });

  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(after.body.data.used).toBe(before.body.data.used);

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/job_missing/promote`));
  expect(missing.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.promote@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/${jobId}/promote`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
