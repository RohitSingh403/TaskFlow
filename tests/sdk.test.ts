import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
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
const payload = {
  to: "user@example.com",
  subject: "Welcome",
  body: "Glad you are here.",
  userId: "user_123",
};

let server: Server;
let baseUrl = "";
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
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  disconnect = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectInfrastructure();
  };
}, 40_000);

afterAll(async () => {
  await disconnect?.();
});

it("submits and reads a job with an API key, and replays the same idempotency key", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.sdk@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "SDK", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const key = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "sdk",
    scopes: ["jobs:read", "jobs:write", "queues:read"],
  });
  expect(key.status).toBe(201);
  const secret = key.body.data.secret as string;

  const client = new TaskFlow({ apiKey: secret, baseUrl });
  const created = await client.jobs.create({
    queue: "emails",
    name: "send-email",
    payload,
    idempotencyKey: "welcome-user-123",
  });
  expect(created.data.id.startsWith("job_")).toBe(true);
  expect(created.data.duplicate).toBe(false);
  expect(created.data.status).toMatch(/waiting|delayed|active/);

  const replay = await client.jobs.create({
    queue: "emails",
    name: "send-email",
    payload,
    idempotencyKey: "welcome-user-123",
  });
  expect(replay.data.id).toBe(created.data.id);
  expect(replay.data.duplicate).toBe(true);

  const fetched = await client.jobs.get(created.data.id);
  expect(fetched.data.queue).toBe("emails");
  expect(fetched.data.name).toBe("send-email");

  const queues = await client.queues.list();
  expect(queues.data.map((queue) => queue.name)).toContain("emails");

  const rejected = new TaskFlow({ apiKey: "tf_live_not_a_key", baseUrl, projectId });
  await expect(rejected.jobs.get(created.data.id)).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
});
