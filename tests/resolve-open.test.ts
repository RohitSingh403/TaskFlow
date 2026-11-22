import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { AlertEvent, AlertRule } from "@taskflow/server";
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

it("resolves the oldest open alerts and leaves the rest open", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.resolve@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

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

  const offline = await client.alerts.rules.create({ type: "worker.offline", name: "Workers down", cooldownMs: 60_000 });
  const backlog = await client.alerts.rules.create({
    type: "queue.backlog",
    name: "Email backlog",
    queue: "emails",
    threshold: 100,
    cooldownMs: 60_000,
  });
  const offlineRule = await AlertRule.findOne({ publicId: offline.data.id });
  const backlogRule = await AlertRule.findOne({ publicId: backlog.data.id });
  if (!offlineRule || !backlogRule) throw new Error("Rules were not stored");

  async function insert(rule: typeof offlineRule, id: string, createdAt: string, status: "open" | "resolved") {
    await AlertEvent.collection.insertOne({
      publicId: id,
      projectId: rule!.projectId,
      projectPublicId: projectId,
      ruleId: rule!._id,
      rulePublicId: rule!.publicId,
      type: rule!.type,
      title: id,
      message: id,
      status,
      ...(status === "resolved" ? { resolvedAt: new Date("2019-12-01T00:00:00Z") } : {}),
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
  }

  await insert(offlineRule, "alert_older", "2020-01-01T00:00:00Z", "open");
  await insert(offlineRule, "alert_newer", "2020-02-01T00:00:00Z", "open");
  await insert(offlineRule, "alert_done", "2020-01-15T00:00:00Z", "resolved");
  await insert(backlogRule, "alert_backlog", "2020-01-10T00:00:00Z", "open");

  const first = await client.alerts.resolveOpen({ limit: 1 });
  expect(first.data).toMatchObject({ resolved: 1, skipped: 0, alertIds: ["alert_older"] });
  const older = await client.alerts.list({ status: "resolved", limit: 50 });
  const olderRow = older.data.find((alert) => alert.id === "alert_older");
  expect(olderRow?.status).toBe("resolved");
  const stillOpen = await client.alerts.list({ status: "open", limit: 50 });
  expect(stillOpen.data.map((alert) => alert.id).sort()).toEqual(["alert_backlog", "alert_newer"]);
  const done = await AlertEvent.findOne({ publicId: "alert_done" });
  expect(done?.resolvedAt?.toISOString()).toBe("2019-12-01T00:00:00.000Z");

  const restOfRule = await client.alerts.resolveOpen({ ruleId: offline.data.id });
  expect(restOfRule.data.alertIds).toEqual(["alert_newer"]);
  const again = await client.alerts.resolveOpen({ ruleId: offline.data.id });
  expect(again.data).toMatchObject({ resolved: 0, skipped: 0, alertIds: [] });
  const backlogStillOpen = await client.alerts.list({ status: "open", limit: 50 });
  expect(backlogStillOpen.data.map((alert) => alert.id)).toEqual(["alert_backlog"]);

  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/resolve-open`)).send({ ruleId: "rule_missing" });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("ALERT_NOT_FOUND");
  const invalid = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/resolve-open`)).send({ limit: 51 });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.resolve@example.com",
    password,
  });
  const blocked = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/resolve-open`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(blocked.status).toBe(404);
});
