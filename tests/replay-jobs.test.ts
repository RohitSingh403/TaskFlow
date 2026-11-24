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

it("copies the oldest finished jobs and leaves waiting jobs and other queues alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.replay-jobs@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Replay", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const archive = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({
    name: "archive",
    description: "Archive",
    concurrency: 2,
    maxWaiting: 1000,
  });
  expect(archive.status).toBe(201);

  async function submit(queue: string, idempotencyKey?: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: "send-email",
      payload,
      priority: "high",
      maxAttempts: 4,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const oldest = await submit("emails", "welcome-replay-batch");
  const waiting = await submit("emails");
  const later = await submit("emails");
  const report = await submit("archive");
  await JobRecord.collection.updateOne(
    { publicId: oldest },
    { $set: { status: "completed", workflowRunId: "wfr_replay_batch", scheduleId: "sch_replay_batch" } },
  );
  await JobRecord.collection.updateOne({ publicId: later }, { $set: { status: "failed" } });
  await JobRecord.collection.updateOne({ publicId: report }, { $set: { status: "completed" } });

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/replay`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/replay`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const missingQueue = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/replay`)).send({ queue: "missing", limit: 1 });
  expect(missingQueue.status).toBe(404);
  expect(missingQueue.body.error.code).toBe("QUEUE_NOT_FOUND");

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
  await expect(reading.jobs.replayJobs({ queue: "emails", limit: 1 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.jobs.replayJobs({ queue: "emails", limit: 1 });
  expect(first.data.replayed).toBe(1);
  expect(first.data.skipped).toBe(0);
  expect(first.data.sourceJobIds).toEqual([oldest]);
  expect(first.data.jobIds).toHaveLength(1);
  const copyId = first.data.jobIds[0];
  expect(copyId).not.toBe(oldest);
  const copy = await writing.jobs.get(copyId);
  expect(copy.data.name).toBe("send-email");
  expect(copy.data.queue).toBe("emails");
  expect(copy.data.priority).toBe("high");
  expect(copy.data.maxAttempts).toBe(4);
  expect(copy.data.delayMs).toBe(0);
  expect(copy.data.status).toMatch(/waiting|active/);
  expect(copy.data.idempotencyKey).toBeNull();
  expect(copy.data.scheduleId).toBeNull();
  expect(copy.data.metadata).toMatchObject({ replayedFrom: oldest });
  const storedCopy = await JobRecord.findOne({ publicId: copyId });
  expect(storedCopy?.workflowRunId ?? null).toBeNull();

  const source = await writing.jobs.get(oldest);
  expect(source.data.status).toBe("completed");
  expect(source.data.idempotencyKey).toBe("welcome-replay-batch");
  expect(source.data.scheduleId).toBe("sch_replay_batch");
  expect((await JobRecord.findOne({ publicId: oldest }))?.workflowRunId).toBe("wfr_replay_batch");
  expect((await writing.jobs.get(waiting)).data.status).toMatch(/waiting|delayed|active/);
  expect((await writing.jobs.get(later)).data.status).toBe("failed");
  expect((await writing.jobs.get(report)).data.status).toBe("completed");

  const second = await writing.jobs.replayJobs({ queue: "emails", limit: 20 });
  expect(second.data.replayed).toBe(2);
  expect(second.data.skipped).toBe(0);
  expect(second.data.sourceJobIds).toEqual([oldest, later]);
  expect(second.data.jobIds).toHaveLength(2);
  expect(second.data.jobIds).not.toContain(report);
  expect((await writing.jobs.get(second.data.jobIds[1])).data.metadata).toMatchObject({ replayedFrom: later });

  const third = await writing.jobs.replayJobs({ limit: 20 });
  expect(third.data.replayed).toBe(3);
  expect(third.data.sourceJobIds).toEqual([oldest, later, report]);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.replay-jobs@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/replay`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
