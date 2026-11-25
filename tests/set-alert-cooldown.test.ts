import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { AlertRule } from "@taskflow/server";
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
const halfHour = 30 * 60 * 1000;
const quarterHour = 15 * 60 * 1000;
const hour = 60 * 60 * 1000;

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

it("sets the cooldown on the oldest rules, including a paused rule and a silenced rule, and leaves a matching or deleted rule alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.set-cooldown@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, extra: Record<string, unknown> = {}) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
      type: "queue.backlog",
      name,
      queue: "emails",
      threshold: 100,
      ...extra,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; name: string };
  }

  const oldest = await create("Morning backlog");
  const later = await create("Evening backlog");
  const matching = await create("Matching backlog", { cooldownMs: halfHour });
  const pausedHook = await create("Paused backlog");
  const quiet = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
    type: "worker.offline",
    name: "Quiet worker",
  });
  expect(quiet.status).toBe(201);
  const removed = await create("Removed backlog");
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/alerts/rules/${pausedHook.id}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const silenced = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/${quiet.body.data.id}/silence`)).send({ durationMs: hour });
  expect(silenced.status).toBe(200);
  const silencedUntil = (await AlertRule.findOne({ publicId: quiet.body.data.id }))?.silencedUntil?.getTime();
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/alerts/rules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/cooldown`)).send({ cooldownMs: halfHour, limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/cooldown`)).send({ cooldownMs: halfHour, limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const tooLow = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/cooldown`)).send({ cooldownMs: 59_999, limit: 1 });
  expect(tooLow.status).toBe(400);
  expect(tooLow.body.error.code).toBe("VALIDATION_ERROR");
  const tooHigh = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/cooldown`)).send({ cooldownMs: 24 * 60 * 60 * 1000 + 1, limit: 1 });
  expect(tooHigh.status).toBe(400);
  expect(tooHigh.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:read", "jobs:write", "analytics:read"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.alerts.rules.setCooldown({ cooldownMs: halfHour, limit: 1 })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.alerts.rules.setCooldown({ cooldownMs: halfHour, limit: 1 });
  expect(first.data).toEqual({ updated: 1, skipped: 0, ruleIds: [oldest.id] });
  const storedOldest = await AlertRule.findOne({ publicId: oldest.id });
  expect(storedOldest?.cooldownMs).toBe(halfHour);
  expect(storedOldest?.name).toBe("Morning backlog");
  expect(storedOldest?.threshold).toBe(100);
  expect(storedOldest?.enabled).toBe(true);
  expect(storedOldest?.silencedUntil ?? null).toBeNull();
  expect(storedOldest?.deletedAt).toBeUndefined();

  const second = await writing.alerts.rules.setCooldown({ cooldownMs: halfHour, limit: 20 });
  expect(second.data).toEqual({
    updated: 3,
    skipped: 2,
    ruleIds: [later.id, pausedHook.id, quiet.body.data.id],
  });
  const storedLater = await AlertRule.findOne({ publicId: later.id });
  expect(storedLater?.cooldownMs).toBe(halfHour);
  expect(storedLater?.name).toBe("Evening backlog");
  expect(storedLater?.threshold).toBe(100);
  const storedPaused = await AlertRule.findOne({ publicId: pausedHook.id });
  expect(storedPaused?.cooldownMs).toBe(halfHour);
  expect(storedPaused?.enabled).toBe(false);
  expect(storedPaused?.name).toBe("Paused backlog");
  expect(storedPaused?.deletedAt).toBeUndefined();
  const storedQuiet = await AlertRule.findOne({ publicId: quiet.body.data.id });
  expect(storedQuiet?.cooldownMs).toBe(halfHour);
  expect(storedQuiet?.type).toBe("worker.offline");
  expect(storedQuiet?.enabled).toBe(true);
  expect(storedQuiet?.name).toBe("Quiet worker");
  expect(storedQuiet?.silencedUntil?.getTime()).toBe(silencedUntil);
  const storedMatching = await AlertRule.findOne({ publicId: matching.id });
  expect(storedMatching?.cooldownMs).toBe(halfHour);
  expect(storedMatching?.name).toBe("Matching backlog");
  const storedRemoved = await AlertRule.findOne({ publicId: removed.id });
  expect(storedRemoved?.deletedAt).toBeInstanceOf(Date);
  expect(storedRemoved?.enabled).toBe(false);
  expect(storedRemoved?.cooldownMs).toBe(quarterHour);

  const again = await writing.alerts.rules.setCooldown({ cooldownMs: halfHour, limit: 20 });
  expect(again.data).toEqual({ updated: 0, skipped: 5, ruleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.set-cooldown@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/cooldown`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ cooldownMs: halfHour, limit: 1 });
  expect(hidden.status).toBe(404);
});
