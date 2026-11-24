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

it("deletes the oldest webhooks, including a paused one, and leaves an already deleted webhook alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.delete-webhooks@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(description: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
      url: "http://127.0.0.1:9/hooks",
      description,
      events: ["job.completed"],
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; secretPrefix: string; enabled: boolean };
  }

  const oldest = await create("Morning hook");
  const later = await create("Evening hook");
  const held = await create("Held hook");
  const removed = await create("Removed hook");
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${held.id}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/webhooks/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/delete`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/delete`)).send({ limit: 51 });
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
  await expect(reading.webhooks.deleteWebhooks({ limit: 1 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.webhooks.deleteWebhooks({ limit: 1 });
  expect(first.data).toEqual({ deleted: 1, skipped: 0, webhookIds: [oldest.id] });
  const storedOldest = await Webhook.findOne({ publicId: oldest.id });
  expect(storedOldest?.deletedAt).toBeInstanceOf(Date);
  expect(storedOldest?.enabled).toBe(false);
  expect(storedOldest?.secretPrefix).toBe(oldest.secretPrefix);
  const listed = await writing.webhooks.list();
  const ids = listed.data.webhooks.map((hook) => hook.id);
  expect(ids).not.toContain(oldest.id);
  expect(ids).toEqual([held.id, later.id]);
  expect(listed.data.webhooks.find((hook) => hook.id === held.id)?.enabled).toBe(false);

  const second = await writing.webhooks.deleteWebhooks({ limit: 20 });
  expect(second.data).toEqual({ deleted: 2, skipped: 0, webhookIds: [later.id, held.id] });
  const storedHeld = await Webhook.findOne({ publicId: held.id });
  expect(storedHeld?.deletedAt).toBeInstanceOf(Date);
  expect(storedHeld?.enabled).toBe(false);
  expect(storedHeld?.secretPrefix).toBe(held.secretPrefix);
  expect((await writing.webhooks.list()).data.webhooks).toEqual([]);

  const again = await writing.webhooks.deleteWebhooks({ limit: 20 });
  expect(again.data).toEqual({ deleted: 0, skipped: 0, webhookIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.delete-webhooks@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/delete`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
