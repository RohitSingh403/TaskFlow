import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { Webhook } from "@taskflow/server";
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

it("replaces the events on the oldest webhooks, keeps a paused endpoint paused, and leaves a matching or deleted endpoint alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.set-events@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(description: string, events: string[]) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
      url: "http://127.0.0.1:9/hooks",
      description,
      events,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; secret: string; secretPrefix: string };
  }

  const oldest = await create("Morning hook", ["job.failed"]);
  const later = await create("Evening hook", ["alert.fired"]);
  const matching = await create("Matching hook", ["job.completed", "alert.fired"]);
  const pausedHook = await create("Paused hook", ["job.cancelled"]);
  const removed = await create("Removed hook", ["job.failed"]);
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${pausedHook.id}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/webhooks/${removed.id}`));
  expect(deleted.status).toBe(200);
  const oldestSecret = (await Webhook.findOne({ publicId: oldest.id }))?.secret;

  const empty = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/events`)).send({ events: [], limit: 1 });
  expect(empty.status).toBe(400);
  expect(empty.body.error.code).toBe("VALIDATION_ERROR");
  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/events`)).send({ events: ["nope"], limit: 1 });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.code).toBe("VALIDATION_ERROR");
  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/events`)).send({ events: ["job.completed"], limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/events`)).send({ events: ["job.completed"], limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

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
  await expect(reading.webhooks.setEvents({ events: ["job.completed"], limit: 1 })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.webhooks.setEvents({ events: ["alert.fired", "job.completed", "job.completed"], limit: 1 });
  expect(first.data).toEqual({ updated: 1, skipped: 0, webhookIds: [oldest.id] });
  const storedOldest = await Webhook.findOne({ publicId: oldest.id });
  expect(storedOldest?.secret).toBe(oldestSecret);
  expect(storedOldest?.secretPrefix).toBe(oldest.secretPrefix);
  expect(storedOldest?.url).toBe("http://127.0.0.1:9/hooks");
  expect(storedOldest?.description).toBe("Morning hook");
  expect(storedOldest?.enabled).toBe(true);
  expect(storedOldest?.events).toEqual(["job.completed", "alert.fired"]);
  expect(storedOldest?.deletedAt).toBeUndefined();
  const listed = await writing.webhooks.list();
  const shown = listed.data.webhooks.find((hook) => hook.id === oldest.id);
  expect(shown?.events).toEqual(["job.completed", "alert.fired"]);
  expect(shown && "secret" in shown).toBe(false);

  const second = await writing.webhooks.setEvents({ events: ["job.completed", "alert.fired"], limit: 20 });
  expect(second.data).toEqual({ updated: 2, skipped: 2, webhookIds: [later.id, pausedHook.id] });
  const storedLater = await Webhook.findOne({ publicId: later.id });
  expect(storedLater?.events).toEqual(["job.completed", "alert.fired"]);
  expect(storedLater?.description).toBe("Evening hook");
  expect(storedLater?.secretPrefix).toBe(later.secretPrefix);
  expect(storedLater?.enabled).toBe(true);
  const storedPaused = await Webhook.findOne({ publicId: pausedHook.id });
  expect(storedPaused?.events).toEqual(["job.completed", "alert.fired"]);
  expect(storedPaused?.enabled).toBe(false);
  expect(storedPaused?.description).toBe("Paused hook");
  expect(storedPaused?.deletedAt).toBeUndefined();
  const storedMatching = await Webhook.findOne({ publicId: matching.id });
  expect(storedMatching?.events).toEqual(["job.completed", "alert.fired"]);
  expect(storedMatching?.description).toBe("Matching hook");
  const storedRemoved = await Webhook.findOne({ publicId: removed.id });
  expect(storedRemoved?.deletedAt).toBeInstanceOf(Date);
  expect(storedRemoved?.enabled).toBe(false);
  expect(storedRemoved?.events).toEqual(["job.failed"]);

  const again = await writing.webhooks.setEvents({ events: ["job.completed", "alert.fired"], limit: 20 });
  expect(again.data).toEqual({ updated: 0, skipped: 4, webhookIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.set-events@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/events`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ events: ["job.completed"], limit: 1 });
  expect(hidden.status).toBe(404);
});
