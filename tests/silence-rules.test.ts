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

it("silences the oldest rules that are still checking and keeps each id", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.silence-rules@example.com",
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
  const held = await create("Notification backlog", "notifications");
  const removed = await create("Worker offline", "emails");
  const heldSilence = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/${held.id}/silence`)).send({ durationMs: day });
  expect(heldSilence.status).toBe(200);
  const heldUntil = heldSilence.body.data.silencedUntil as string;
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/alerts/rules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/silence`)).send({ durationMs: hour, limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/silence`)).send({ durationMs: hour, limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const tooShort = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/silence`)).send({ durationMs: 1000, limit: 1 });
  expect(tooShort.status).toBe(400);
  expect(tooShort.body.error.code).toBe("VALIDATION_ERROR");

  const before = Date.now();
  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/silence`)).send({ durationMs: hour, limit: 1 });
  const after = Date.now();
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ silenced: 1, skipped: 0, ruleIds: [oldest.id] });
  const oldestAfter = (await asAda(ada.get(`/api/v1/projects/${projectId}/alerts/rules`))).body.data.find((rule: { id: string }) => rule.id === oldest.id);
  expect(oldestAfter.enabled).toBe(true);
  expect(oldestAfter.name).toBe("Email backlog");
  const until = new Date(oldestAfter.silencedUntil).getTime();
  expect(until).toBeGreaterThanOrEqual(before + hour);
  expect(until).toBeLessThanOrEqual(after + hour);
  const laterStill = (await asAda(ada.get(`/api/v1/projects/${projectId}/alerts/rules`))).body.data.find((rule: { id: string }) => rule.id === later.id);
  expect(laterStill.silencedUntil).toBeNull();
  const heldStill = (await asAda(ada.get(`/api/v1/projects/${projectId}/alerts/rules`))).body.data.find((rule: { id: string }) => rule.id === held.id);
  expect(heldStill.silencedUntil).toBe(heldUntil);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["analytics:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/silence`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ durationMs: hour, limit: 20 });
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
  const second = await client.alerts.rules.silenceRules({ durationMs: hour, limit: 20 });
  expect(second.data).toEqual({ silenced: 1, skipped: 0, ruleIds: [later.id] });
  const listed = await client.alerts.rules.list();
  const laterAfter = listed.data.find((rule) => rule.id === later.id);
  expect(laterAfter?.id).toBe(later.id);
  expect(laterAfter?.enabled).toBe(true);
  expect(laterAfter?.silencedUntil).toBeTruthy();
  const removedAfter = await AlertRule.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.silencedUntil ?? null).toBeNull();

  const again = await client.alerts.rules.silenceRules({ durationMs: hour, limit: 20 });
  expect(again.data).toEqual({ silenced: 0, skipped: 0, ruleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.silence-rules@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/silence`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ durationMs: hour, limit: 1 });
  expect(hidden.status).toBe(404);
});
