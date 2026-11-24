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

it("deletes the oldest alert rules, including a paused one and a silenced one, and leaves an already deleted rule alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.delete-rules@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Alerts", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules`)).send({
      type: "queue.backlog",
      name,
      queue: "emails",
      threshold: 100,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; name: string; enabled: boolean };
  }

  const oldest = await create("Morning backlog");
  const later = await create("Evening backlog");
  const held = await create("Held backlog");
  const quiet = await create("Quiet backlog");
  const removed = await create("Removed backlog");
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/alerts/rules/${held.id}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const silenced = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/${quiet.id}/silence`)).send({ durationMs: hour });
  expect(silenced.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/alerts/rules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/delete`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/alerts/rules/delete`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:write", "analytics:read"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.alerts.rules.deleteRules({ limit: 1 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.alerts.rules.deleteRules({ limit: 1 });
  expect(first.data).toEqual({ deleted: 1, skipped: 0, ruleIds: [oldest.id] });
  const storedOldest = await AlertRule.findOne({ publicId: oldest.id });
  expect(storedOldest?.deletedAt).toBeInstanceOf(Date);
  expect(storedOldest?.enabled).toBe(false);
  expect(storedOldest?.name).toBe("Morning backlog");
  expect(storedOldest?.threshold).toBe(100);
  const listed = await writing.alerts.rules.list();
  expect(listed.data.map((rule) => rule.id).sort()).toEqual([held.id, later.id, quiet.id].sort());
  expect(listed.data.find((rule) => rule.id === held.id)?.enabled).toBe(false);
  expect(listed.data.find((rule) => rule.id === quiet.id)?.silencedUntil).toBeTruthy();

  const second = await writing.alerts.rules.deleteRules({ limit: 20 });
  expect(second.data).toEqual({ deleted: 3, skipped: 0, ruleIds: [later.id, held.id, quiet.id] });
  const storedHeld = await AlertRule.findOne({ publicId: held.id });
  expect(storedHeld?.deletedAt).toBeInstanceOf(Date);
  expect(storedHeld?.enabled).toBe(false);
  expect(storedHeld?.name).toBe("Held backlog");
  expect(storedHeld?.threshold).toBe(100);
  const storedQuiet = await AlertRule.findOne({ publicId: quiet.id });
  expect(storedQuiet?.deletedAt).toBeInstanceOf(Date);
  expect(storedQuiet?.enabled).toBe(false);
  expect(storedQuiet?.silencedUntil).toBeInstanceOf(Date);
  expect(storedQuiet?.name).toBe("Quiet backlog");
  expect((await writing.alerts.rules.list()).data).toEqual([]);

  const again = await writing.alerts.rules.deleteRules({ limit: 20 });
  expect(again.data).toEqual({ deleted: 0, skipped: 0, ruleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.delete-rules@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/alerts/rules/delete`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
