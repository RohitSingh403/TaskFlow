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

it("changes the priority of a queued job and leaves its delay and workflow run alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.priority@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Priority", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const waiting = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    priority: "medium",
    idempotencyKey: "welcome-priority-once",
  });
  expect(waiting.status).toBe(201);
  const jobId = waiting.body.data.id as string;
  await JobRecord.collection.updateOne(
    { publicId: jobId },
    { $set: { workflowRunId: "wfr_priority_waiting", scheduleId: "sch_priority_waiting" } },
  );

  const delayed = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    priority: "low",
    delayMs: 60_000,
  });
  expect(delayed.status).toBe(201);
  const delayedId = delayed.body.data.id as string;

  const finished = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(finished.status).toBe(201);
  const finishedId = finished.body.data.id as string;
  await JobRecord.collection.updateOne({ publicId: finishedId }, { $set: { status: "completed" } });

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
  await expect(reading.jobs.updatePriority(jobId, { priority: "high" })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const raised = await writing.jobs.updatePriority(jobId, { priority: "high" });
  expect(raised.data.id).toBe(jobId);
  expect(raised.data.priority).toBe("high");
  expect(raised.data.status).toMatch(/waiting|active/);
  expect(raised.data.idempotencyKey).toBe("welcome-priority-once");
  expect(raised.data.scheduleId).toBe("sch_priority_waiting");
  const stored = await JobRecord.findOne({ publicId: jobId });
  expect(stored?.workflowRunId).toBe("wfr_priority_waiting");
  expect(stored?.priorityValue).toBe(1);
  const bullJob = await getBullQueue(stored!.bullQueueName).getJob(jobId);
  expect(bullJob?.priority).toBe(1);
  expect(await bullJob?.getState()).toMatch(/waiting|prioritized|active|paused/);

  const same = await writing.jobs.updatePriority(jobId, { priority: "high" });
  expect(same.data.id).toBe(jobId);
  expect(same.data.priority).toBe("high");

  const later = await writing.jobs.updatePriority(delayedId, { priority: "high" });
  expect(later.data.id).toBe(delayedId);
  expect(later.data.priority).toBe("high");
  expect(later.data.status).toBe("delayed");
  expect(later.data.delayMs).toBe(60_000);
  const delayedRecord = await JobRecord.findOne({ publicId: delayedId });
  const delayedBull = await getBullQueue(delayedRecord!.bullQueueName).getJob(delayedId);
  expect(delayedBull?.priority).toBe(1);
  expect(await delayedBull?.getState()).toBe("delayed");

  const done = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${finishedId}/priority`)).send({ priority: "high" });
  expect(done.status).toBe(409);
  expect(done.body.error.code).toBe("JOB_NOT_QUEUED");

  const invalid = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${jobId}/priority`)).send({ priority: "urgent" });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(after.body.data.used).toBe(before.body.data.used);

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/job_missing/priority`)).send({ priority: "low" });
  expect(missing.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.priority@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/${jobId}/priority`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ priority: "low" });
  expect(hidden.status).toBe(404);
});
