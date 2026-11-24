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

it("removes the oldest jobs that are not active and leaves an active job and an already removed job alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.remove-jobs@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Remove", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const archive = await asAda(ada.post(`/api/v1/projects/${projectId}/queues`)).send({
    name: "archive",
    description: "Archive",
    concurrency: 2,
    maxWaiting: 1000,
  });
  expect(archive.status).toBe(201);

  async function submit(queue: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: "send-email",
      payload,
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const oldest = await submit("emails");
  const later = await submit("emails");
  const active = await submit("emails");
  const held = await submit("emails");
  const archived = await submit("archive");
  await JobRecord.collection.updateOne({ publicId: later }, { $set: { status: "completed" } });
  await JobRecord.collection.updateOne({ publicId: active }, { $set: { status: "active" } });
  await JobRecord.collection.updateOne({ publicId: archived }, { $set: { status: "completed" } });
  const heldRemoved = await asAda(ada.delete(`/api/v1/projects/${projectId}/jobs/${held}`));
  expect(heldRemoved.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/remove`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/remove`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const missingQueue = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/remove`)).send({ queue: "missing", limit: 1 });
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
  await expect(reading.jobs.removeJobs({ queue: "emails", limit: 1 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.jobs.removeJobs({ queue: "emails", limit: 1 });
  expect(first.data).toEqual({ removed: 1, skipped: 0, jobIds: [oldest] });
  const oldestJob = await writing.jobs.get(oldest);
  expect(oldestJob.data.id).toBe(oldest);
  expect(oldestJob.data.status).toBe("cancelled");
  expect((await JobRecord.findOne({ publicId: oldest }))?.removedAt).toBeInstanceOf(Date);
  expect((await writing.jobs.get(later)).data.status).toBe("completed");
  expect((await writing.jobs.get(active)).data.status).toBe("active");
  expect((await writing.jobs.get(archived)).data.status).toBe("completed");

  const second = await writing.jobs.removeJobs({ queue: "emails", limit: 20 });
  expect(second.data).toEqual({ removed: 1, skipped: 0, jobIds: [later] });
  expect((await writing.jobs.get(later)).data.id).toBe(later);
  expect((await writing.jobs.get(later)).data.status).toBe("completed");
  expect((await JobRecord.findOne({ publicId: later }))?.removedAt).toBeInstanceOf(Date);
  expect((await writing.jobs.get(active)).data.status).toBe("active");
  expect((await JobRecord.findOne({ publicId: active }))?.removedAt ?? null).toBeNull();

  const again = await writing.jobs.removeJobs({ queue: "emails", limit: 20 });
  expect(again.data).toEqual({ removed: 0, skipped: 0, jobIds: [] });

  const third = await writing.jobs.removeJobs({ limit: 1 });
  expect(third.data).toEqual({ removed: 1, skipped: 0, jobIds: [archived] });
  expect((await writing.jobs.get(archived)).data.status).toBe("completed");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.remove-jobs@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/remove`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
