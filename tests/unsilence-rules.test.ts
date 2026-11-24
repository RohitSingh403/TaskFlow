import { createServer, type Server } from "node:http";
import { AlertRule } from "@taskflow/server";
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
const hour = 60 * 60 * 1000;
const day = 24 * hour;

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

it("clears silence on the oldest silenced rules and keeps each id", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.unsilence-rules@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, queue: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
      type: "queue.backlog",
      name,
      queue,
      threshold: 10,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; name: string; enabled: boolean; silencedUntil: string | null };
  }

  const oldest = await create("Email backlog", "emails");
  const later = await create("Report backlog", "reports");
  const checking = await create("Notification backlog", "notifications");
  const removed = await create("Import backlog", "emails");
  for (const rule of [oldest, later, removed]) {
    const silenced = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/${rule.id}/silence`)).send({ durationMs: day });
    expect(silenced.status).toBe(200);
  }
  const laterBefore = (await asAda(ada.get(`/api/v1/projects/${projectId}/alerts/rules`))).body.data.find((rule: { id: string }) => rule.id === later.id);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/alerts/rules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/unsilence`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/unsilence`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/unsilence`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ unsilenced: 1, skipped: 0, ruleIds: [oldest.id] });
  const listed = (await asAda(ada.get(`/api/v1/projects/${projectId}/alerts/rules`))).body.data as { id: string; name: string; enabled: boolean; silencedUntil: string | null }[];
  const oldestAfter = listed.find((rule) => rule.id === oldest.id);
  expect(oldestAfter?.enabled).toBe(true);
  expect(oldestAfter?.name).toBe("Email backlog");
  expect(oldestAfter?.silencedUntil).toBeNull();
  const laterStill = listed.find((rule) => rule.id === later.id);
  expect(laterStill?.silencedUntil).toBe(laterBefore.silencedUntil);
  const checkingStill = listed.find((rule) => rule.id === checking.id);
  expect(checkingStill?.silencedUntil).toBeNull();

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["analytics:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/unsilence`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write", "analytics:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const second = await client.alerts.rules.unsilenceRules({ limit: 20 });
  expect(second.data).toEqual({ unsilenced: 1, skipped: 0, ruleIds: [later.id] });
  const laterAfter = (await client.alerts.rules.list()).data.find((rule) => rule.id === later.id);
  expect(laterAfter?.id).toBe(later.id);
  expect(laterAfter?.enabled).toBe(true);
  expect(laterAfter?.silencedUntil).toBeNull();
  const removedAfter = await AlertRule.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.silencedUntil).toBeTruthy();

  const again = await client.alerts.rules.unsilenceRules({ limit: 20 });
  expect(again.data).toEqual({ unsilenced: 0, skipped: 0, ruleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.unsilence-rules@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/unsilence`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
