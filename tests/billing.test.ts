import { createServer, type Server } from "node:http";
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
const payload = { to: "user@example.com", subject: "Welcome", body: "Glad you are here." };

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
  delete process.env.TASKFLOW_PLAN_ALLOWANCE;
  await disconnect?.();
});

it("stops new jobs at the monthly allowance and lets the owner raise the plan", async () => {
  process.env.TASKFLOW_PLAN_ALLOWANCE = "1";
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.billing@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.billing@example.com",
    password,
  });
  const graceToken = grace.body.data.accessToken as string;

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Billing", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    idempotencyKey: "billing-welcome-1",
  });
  expect(first.status).toBe(201);

  const replay = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
    idempotencyKey: "billing-welcome-1",
  });
  expect(replay.status).toBe(200);
  expect(replay.body.data.duplicate).toBe(true);

  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(blocked.status).toBe(402);
  expect(blocked.body.error.code).toBe("PLAN_LIMIT");

  const usage = await asAda(ada.get(`/api/v1/projects/${projectId}/billing`));
  expect(usage.status).toBe(200);
  expect(usage.body.data.plan).toBe("developer");
  expect(usage.body.data.used).toBe(1);
  expect(usage.body.data.allowance).toBe(1);

  await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.billing@example.com" });
  const memberChange = await request(server)
    .patch(`/api/v1/projects/${projectId}/billing`)
    .set("Authorization", `Bearer ${graceToken}`)
    .send({ plan: "scale" });
  expect(memberChange.status).toBe(403);

  const raised = await asAda(ada.patch(`/api/v1/projects/${projectId}/billing`)).send({ plan: "scale" });
  expect(raised.status).toBe(200);
  expect(raised.body.data.plan).toBe("scale");
  expect(raised.body.data.allowance).toBe(50_000);

  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload,
  });
  expect(second.status).toBe(201);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.billing@example.com",
    password,
  });
  const hidden = await request(server)
    .get(`/api/v1/projects/${projectId}/billing`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
  delete process.env.TASKFLOW_PLAN_ALLOWANCE;
});
