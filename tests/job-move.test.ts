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

it("moves a delayed job to another queue and leaves a full queue and a workflow step alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.move@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Move", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const delayed = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    priority: "high",
    delayMs: 60_000,
    idempotencyKey: "welcome-move-once",
  });
  expect(delayed.status).toBe(201);
  const jobId = delayed.body.data.id as string;
  await JobRecord.collection.updateOne({ publicId: jobId }, { $set: { scheduleId: "sch_move_source" } });

  const occupant = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "reports",
    name: "send-email",
    payload,
  });
  expect(occupant.status).toBe(201);

  const step = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(step.status).toBe(201);
  const stepId = step.body.data.id as string;
  await JobRecord.collection.updateOne({ publicId: stepId }, { $set: { workflowRunId: "wfr_move_step" } });

  const finished = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(finished.status).toBe(201);
  await JobRecord.collection.updateOne({ publicId: finished.body.data.id }, { $set: { status: "completed" } });

  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  expect(queues.status).toBe(200);
  const reports = (queues.body.data as { id: string; name: string }[]).find((queue) => queue.name === "reports");
  expect(reports).toBeTruthy();
  const limited = await asAda(ada.patch(`/api/v1/projects/${projectId}/queues/${reports!.id}`)).send({ maxWaiting: 1 });
  expect(limited.status).toBe(200);

  const before = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(before.status).toBe(200);
  const source = await JobRecord.findOne({ publicId: jobId });
  const sourceQueue = source!.bullQueueName;

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
  await expect(reading.jobs.move(jobId, { queue: "reports" })).rejects.toMatchObject({ status: 403 });

  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${jobId}/queue`)).send({ queue: "reports" });
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe("QUEUE_BACKPRESSURE");
  const stayed = await JobRecord.findOne({ publicId: jobId });
  expect(stayed?.queueName).toBe("emails");
  expect(await getBullQueue(sourceQueue).getJob(jobId)).toBeTruthy();

  const opened = await asAda(ada.patch(`/api/v1/projects/${projectId}/queues/${reports!.id}`)).send({ maxWaiting: 100 });
  expect(opened.status).toBe(200);

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const same = await writing.jobs.move(jobId, { queue: "emails" });
  expect(same.data.id).toBe(jobId);
  expect(same.data.queue).toBe("emails");

  const moved = await writing.jobs.move(jobId, { queue: "reports" });
  expect(moved.data.id).toBe(jobId);
  expect(moved.data.queue).toBe("reports");
  expect(moved.data.status).toBe("delayed");
  expect(moved.data.delayMs).toBe(60_000);
  expect(moved.data.priority).toBe("high");
  expect(moved.data.idempotencyKey).toBe("welcome-move-once");
  expect(moved.data.scheduleId).toBe("sch_move_source");
  const stored = await JobRecord.findOne({ publicId: jobId });
  expect(stored?.workflowRunId ?? null).toBeNull();
  expect(await getBullQueue(sourceQueue).getJob(jobId)).toBeFalsy();
  const destination = await getBullQueue(stored!.bullQueueName).getJob(jobId);
  expect(await destination?.getState()).toBe("delayed");

  const held = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${stepId}/queue`)).send({ queue: "reports" });
  expect(held.status).toBe(409);
  expect(held.body.error.code).toBe("WORKFLOW_JOB");
  expect((await JobRecord.findOne({ publicId: stepId }))?.queueName).toBe("emails");

  const done = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${finished.body.data.id}/queue`)).send({ queue: "reports" });
  expect(done.status).toBe(409);
  expect(done.body.error.code).toBe("JOB_NOT_QUEUED");

  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${jobId}/queue`)).send({ queue: "missing-queue" });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("QUEUE_NOT_FOUND");

  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(after.body.data.used).toBe(before.body.data.used);

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/job_missing/queue`)).send({ queue: "emails" });
  expect(missing.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.move@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/${jobId}/queue`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ queue: "emails" });
  expect(hidden.status).toBe(404);
});
