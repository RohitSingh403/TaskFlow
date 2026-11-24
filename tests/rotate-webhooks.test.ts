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

it("replaces the signing secret on each of the oldest webhooks and shows each secret once", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.rotate-webhooks@example.com",
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
    return created.body.data as { id: string; secret: string; secretPrefix: string; enabled: boolean };
  }

  const oldest = await create("Morning hook");
  const later = await create("Evening hook");
  const held = await create("Held hook");
  const removed = await create("Removed hook");
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${held.id}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/webhooks/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/rotate`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/rotate`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/rotate`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data.rotated).toBe(1);
  expect(first.body.data.skipped).toBe(0);
  expect(first.body.data.webhookIds).toEqual([oldest.id]);
  const firstSecret = first.body.data.secrets[0] as { webhookId: string; url: string; secret: string; secretPrefix: string };
  expect(firstSecret.webhookId).toBe(oldest.id);
  expect(firstSecret.url).toBe("http://127.0.0.1:9/hooks");
  expect(firstSecret.secret.startsWith("whsec_")).toBe(true);
  expect(firstSecret.secret).not.toBe(oldest.secret);
  expect(firstSecret.secretPrefix).toBe(`${firstSecret.secret.slice(0, 12)}…`);
  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  const hooks = listed.body.data.webhooks as { id: string; secretPrefix: string; enabled: boolean; secret?: string }[];
  const oldestListed = hooks.find((hook) => hook.id === oldest.id);
  expect(oldestListed?.secretPrefix).toBe(firstSecret.secretPrefix);
  expect(oldestListed?.secret).toBeUndefined();
  expect(oldestListed?.enabled).toBe(true);
  expect(hooks.find((hook) => hook.id === later.id)?.secretPrefix).toBe(later.secretPrefix);
  const heldListed = hooks.find((hook) => hook.id === held.id);
  expect(heldListed?.enabled).toBe(false);
  expect(heldListed?.secretPrefix).toBe(held.secretPrefix);
  const removedAfter = await Webhook.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/rotate`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write", "jobs:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const second = await client.webhooks.rotateWebhooks({ limit: 20 });
  expect(second.data.rotated).toBe(3);
  expect(second.data.skipped).toBe(0);
  expect(second.data.webhookIds).toEqual([oldest.id, later.id, held.id]);
  expect(second.data.secrets.map((item) => item.secret)).not.toContain(firstSecret.secret);
  expect(new Set(second.data.secrets.map((item) => item.secret)).size).toBe(3);
  const afterSecond = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  const secondHooks = afterSecond.body.data.webhooks as { id: string; secretPrefix: string; enabled: boolean }[];
  for (const item of second.data.secrets) {
    expect(item.secretPrefix).toBe(`${item.secret.slice(0, 12)}…`);
    expect(secondHooks.find((hook) => hook.id === item.webhookId)?.secretPrefix).toBe(item.secretPrefix);
  }
  expect(secondHooks.find((hook) => hook.id === held.id)?.enabled).toBe(false);
  const removedStill = await Webhook.findOne({ publicId: removed.id });
  expect(removedStill?.deletedAt).toBeTruthy();
  expect(removedStill?.secret).not.toBe(second.data.secrets.find((item) => item.webhookId === removed.id)?.secret);

  const again = await client.webhooks.rotateWebhooks({ limit: 20 });
  expect(again.data.rotated).toBe(3);
  expect(again.data.skipped).toBe(0);
  expect(again.data.webhookIds).toEqual([oldest.id, later.id, held.id]);
  const previous = new Set(second.data.secrets.map((item) => item.secret));
  expect(again.data.secrets.every((item) => !previous.has(item.secret))).toBe(true);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.rotate-webhooks@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/rotate`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
