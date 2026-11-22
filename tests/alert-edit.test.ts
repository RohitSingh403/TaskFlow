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

it("changes an alert threshold without clearing its silence", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.alertedit@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "queue.backlog",
    name: "Email backlog",
    queue: "emails",
    threshold: 100,
  });
  expect(created.status).toBe(201);
  const ruleId = created.body.data.id as string;

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:write", "jobs:read", "analytics:read"],
  });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });

  const silenced = await client.alerts.rules.silence(ruleId, { durationMs: 60 * 60 * 1000 });
  expect(silenced.data.silencedUntil).toEqual(expect.any(String));

  const updated = await client.alerts.rules.update(ruleId, { name: "Mail backlog", threshold: 250 });
  expect(updated.data.id).toBe(ruleId);
  expect(updated.data.name).toBe("Mail backlog");
  expect(updated.data.threshold).toBe(250);
  expect(updated.data.enabled).toBe(true);
  expect(updated.data.silencedUntil).toBe(silenced.data.silencedUntil);

  const rate = await client.alerts.rules.create({
    type: "failure.rate",
    name: "Failures",
    threshold: 25,
  });
  const tooHigh = await asAda(ada.patch(`/api/v1/projects/${projectId}/alerts/rules/${rate.data.id}`)).send({ threshold: 101 });
  expect(tooHigh.status).toBe(400);
  expect(tooHigh.body.error.code).toBe("VALIDATION_ERROR");

  const offline = await client.alerts.rules.create({ type: "worker.offline", name: "Workers" });
  const rejected = await asAda(ada.patch(`/api/v1/projects/${projectId}/alerts/rules/${offline.data.id}`)).send({ threshold: 5 });
  expect(rejected.status).toBe(400);
  expect(rejected.body.error.code).toBe("VALIDATION_ERROR");

  const duplicate = await asAda(ada.patch(`/api/v1/projects/${projectId}/alerts/rules/${rate.data.id}`)).send({ name: "Mail backlog" });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("ALERT_EXISTS");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.alertedit@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}/alerts/rules/${ruleId}`)
    .send({ name: "Taken" })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
