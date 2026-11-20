import { createServer, type Server } from "node:http";
import { JobAttempt, JobRecord, purgeExpiredJobs } from "@taskflow/server";
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
const day = 86_400_000;

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

it("deletes finished jobs older than the project retention and keeps the rest", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.retention@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.retention@example.com",
    password,
  });
  const graceToken = grace.body.data.accessToken as string;

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Retention", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  expect(project.body.data.jobRetentionDays).toBe(30);

  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.retention@example.com" });
  expect(invited.status).toBe(201);
  const memberChange = await request(server)
    .patch(`/api/v1/projects/${projectId}`)
    .set("Authorization", `Bearer ${graceToken}`)
    .send({ jobRetentionDays: 1 });
  expect(memberChange.status).toBe(403);

  const saved = await asAda(ada.patch(`/api/v1/projects/${projectId}`)).send({ jobRetentionDays: 1 });
  expect(saved.status).toBe(200);
  expect(saved.body.data.jobRetentionDays).toBe(1);

  async function submit() {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue: "emails",
      name: "send-email",
      payload,
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const oldId = await submit();
  const recentId = await submit();
  const waitingId = await submit();
  const old = await JobRecord.findOne({ publicId: oldId });
  expect(old).toBeTruthy();
  await JobAttempt.create({
    jobId: old!._id,
    jobPublicId: old!.publicId,
    projectId: old!.projectId,
    attemptNumber: 1,
    startedAt: new Date(Date.now() - 2 * day),
    status: "completed",
  });
  const aged = new Date(Date.now() - 2 * day);
  await JobRecord.collection.updateOne({ publicId: oldId }, { $set: { status: "completed", updatedAt: aged } });
  await JobRecord.collection.updateOne({ publicId: recentId }, { $set: { status: "completed", updatedAt: new Date() } });
  await JobRecord.collection.updateOne({ publicId: waitingId }, { $set: { updatedAt: aged } });

  const purged = await purgeExpiredJobs(new Date());
  expect(purged.jobs).toBe(1);
  expect(await JobRecord.findOne({ publicId: oldId })).toBeNull();
  expect(await JobAttempt.countDocuments({ jobPublicId: oldId })).toBe(0);
  expect((await JobRecord.findOne({ publicId: recentId }))?.status).toBe("completed");
  expect((await JobRecord.findOne({ publicId: waitingId }))?.status).toBe("waiting");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.retention@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ jobRetentionDays: 7 });
  expect(hidden.status).toBe(404);
});
