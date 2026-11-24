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

it("queues one test for each of the oldest enabled webhooks and leaves the signing secret unchanged", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.test-webhooks@example.com",
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

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/test`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/test`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/test`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data.queued).toBe(1);
  expect(first.body.data.skipped).toBe(0);
  expect(first.body.data.webhookIds).toEqual([oldest.id]);
  expect(first.body.data.deliveryIds).toHaveLength(1);
  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  const deliveries = listed.body.data.deliveries as { id: string; webhookId: string; event: string }[];
  const hooks = listed.body.data.webhooks as { id: string; secretPrefix: string; enabled: boolean }[];
  expect(deliveries.filter((delivery) => delivery.event === "webhook.test").map((delivery) => ({
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
  }))).toEqual([
    { id: first.body.data.deliveryIds[0], webhookId: oldest.id, event: "webhook.test" },
  ]);
  expect(hooks.find((hook) => hook.id === oldest.id)?.secretPrefix).toBe(oldest.secretPrefix);
  expect(hooks.find((hook) => hook.id === later.id)?.enabled).toBe(true);
  expect(deliveries.some((delivery) => delivery.webhookId === later.id)).toBe(false);
  expect(hooks.find((hook) => hook.id === held.id)?.enabled).toBe(false);
  expect(deliveries.some((delivery) => delivery.webhookId === held.id)).toBe(false);
  const removedAfter = await Webhook.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/test`)
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
  const second = await client.webhooks.testWebhooks({ limit: 20 });
  expect(second.data.queued).toBe(2);
  expect(second.data.skipped).toBe(0);
  expect(second.data.webhookIds).toEqual([oldest.id, later.id]);
  expect(new Set(second.data.deliveryIds).size).toBe(2);
  expect(second.data.deliveryIds).not.toContain(first.body.data.deliveryIds[0]);
  const afterSecond = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  const secondHooks = afterSecond.body.data.webhooks as { id: string; secretPrefix: string; enabled: boolean }[];
  const secondDeliveries = afterSecond.body.data.deliveries as { id: string; webhookId: string; event: string }[];
  expect(secondHooks.find((hook) => hook.id === oldest.id)?.secretPrefix).toBe(oldest.secretPrefix);
  expect(secondDeliveries.filter((delivery) => delivery.webhookId === later.id && delivery.event === "webhook.test")).toHaveLength(1);
  expect(secondDeliveries.some((delivery) => delivery.webhookId === held.id)).toBe(false);
  const removedStill = await Webhook.findOne({ publicId: removed.id });
  expect(removedStill?.deletedAt).toBeTruthy();

  const again = await client.webhooks.testWebhooks({ limit: 20 });
  expect(again.data.queued).toBe(2);
  expect(again.data.skipped).toBe(0);
  expect(again.data.webhookIds).toEqual([oldest.id, later.id]);
  expect(again.data.deliveryIds.every((deliveryId) => !second.data.deliveryIds.includes(deliveryId))).toBe(true);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.test-webhooks@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/test`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
