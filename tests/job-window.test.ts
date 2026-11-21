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

it("returns jobs created inside the window and rejects a start that is after the end", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.window@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Window", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const older = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  const newer = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(older.status).toBe(201);
  expect(newer.status).toBe(201);
  const olderId = older.body.data.id as string;
  const newerId = newer.body.data.id as string;
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
  const moved = await JobRecord.collection.updateOne({ publicId: olderId }, { $set: { createdAt: threeDaysAgo } });
  expect(moved.matchedCount).toBe(1);

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const recent = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs`)).query({ from: dayAgo });
  expect(recent.status).toBe(200);
  expect(recent.body.data.map((job: { id: string }) => job.id)).toEqual([newerId]);

  const early = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs`)).query({ to: twoDaysAgo });
  expect(early.status).toBe(200);
  expect(early.body.data.map((job: { id: string }) => job.id)).toEqual([olderId]);

  const inverted = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs`)).query({ from: dayAgo, to: twoDaysAgo });
  expect(inverted.status).toBe(400);
  expect(inverted.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: reader.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const listed = await client.jobs.list({ from: dayAgo });
  expect(listed.data.map((job) => job.id)).toEqual([newerId]);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.window@example.com",
    password,
  });
  const hidden = await request(server)
    .get(`/api/v1/projects/${projectId}/jobs`)
    .query({ from: dayAgo })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
