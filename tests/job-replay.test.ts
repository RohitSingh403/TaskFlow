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

it("queues a new copy and leaves the original job, its schedule, and its workflow run alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.replay@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Replay", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    priority: "high",
    maxAttempts: 4,
    delayMs: 60_000,
    idempotencyKey: "welcome-replay-once",
  });
  expect(created.status).toBe(201);
  const sourceId = created.body.data.id as string;
  await JobRecord.collection.updateOne(
    { publicId: sourceId },
    { $set: { workflowRunId: "wfr_replay_source", scheduleId: "sch_replay_source" } },
  );

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
  await expect(reading.jobs.replay(sourceId)).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.jobs.replay(sourceId);
  const second = await writing.jobs.replay(sourceId);
  expect(first.data.id.startsWith("job_")).toBe(true);
  expect(first.data.id).not.toBe(sourceId);
  expect(second.data.id).not.toBe(first.data.id);
  expect(first.data.name).toBe("send-email");
  expect(first.data.queue).toBe("emails");
  expect(first.data.priority).toBe("high");
  expect(first.data.maxAttempts).toBe(4);
  expect(first.data.delayMs).toBe(0);
  expect(first.data.status).toMatch(/waiting|active/);
  expect(first.data.idempotencyKey).toBeNull();
  expect(first.data.scheduleId).toBeNull();
  expect(first.data.payload).toMatchObject({ subject: "Welcome" });
  expect(first.data.metadata).toMatchObject({ replayedFrom: sourceId });

  const copy = await JobRecord.findOne({ publicId: first.data.id });
  expect(copy?.workflowRunId ?? null).toBeNull();
  expect(copy?.scheduleId ?? null).toBeNull();

  const source = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${sourceId}`));
  expect(source.status).toBe(200);
  expect(source.body.data.status).toBe("delayed");
  expect(source.body.data.delayMs).toBe(60_000);
  expect(source.body.data.idempotencyKey).toBe("welcome-replay-once");
  expect(source.body.data.scheduleId).toBe("sch_replay_source");
  const stored = await JobRecord.findOne({ publicId: sourceId });
  expect(stored?.workflowRunId).toBe("wfr_replay_source");

  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(after.body.data.used).toBe(before.body.data.used + 2);

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/job_missing/replay`));
  expect(missing.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.replay@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/${sourceId}/replay`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
