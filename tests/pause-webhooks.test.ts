import { createServer, type Server } from "node:http";
import { Webhook } from "@taskflow/server";
import { TaskFlow, TaskFlowError } from "@taskflow/sdk";
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

it("pauses the oldest enabled webhooks and keeps each id and secret", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.pause-webhooks@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(path: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
      url: `http://127.0.0.1:9/${path}`,
      description: path,
      events: ["job.completed"],
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; url: string; enabled: boolean; secretPrefix: string };
  }

  const oldest = await create("oldest");
  const later = await create("later");
  const held = await create("held");
  const removed = await create("removed");
  const heldPause = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${held.id}`)).send({ enabled: false });
  expect(heldPause.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/webhooks/${removed.id}`));
  expect(deleted.status).toBe(200);
  await Webhook.collection.updateOne({ publicId: removed.id }, { $set: { enabled: true } });

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/pause`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/pause`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/pause`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ paused: 1, skipped: 0, webhookIds: [oldest.id] });
  const listed = (await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`))).body.data.webhooks as {
    id: string;
    url: string;
    enabled: boolean;
    secretPrefix: string;
    description: string;
  }[];
  const oldestAfter = listed.find((hook) => hook.id === oldest.id);
  expect(oldestAfter?.enabled).toBe(false);
  expect(oldestAfter?.url).toBe("http://127.0.0.1:9/oldest");
  expect(oldestAfter?.secretPrefix).toBe(oldest.secretPrefix);
  expect(oldestAfter?.description).toBe("oldest");
  const refused = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${oldest.id}/test`));
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("WEBHOOK_DISABLED");
  const laterStill = listed.find((hook) => hook.id === later.id);
  expect(laterStill?.enabled).toBe(true);
  const heldStill = listed.find((hook) => hook.id === held.id);
  expect(heldStill?.enabled).toBe(false);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/pause`)
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
  const second = await client.webhooks.pauseWebhooks({ limit: 20 });
  expect(second.data).toEqual({ paused: 1, skipped: 0, webhookIds: [later.id] });
  const laterAfter = (await client.webhooks.list()).data.webhooks.find((hook) => hook.id === later.id);
  expect(laterAfter?.id).toBe(later.id);
  expect(laterAfter?.enabled).toBe(false);
  expect(laterAfter?.secretPrefix).toBe(later.secretPrefix);
  const removedAfter = await Webhook.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.enabled).toBe(true);

  const again = await client.webhooks.pauseWebhooks({ limit: 20 });
  expect(again.data).toEqual({ paused: 0, skipped: 0, webhookIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.pause-webhooks@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/pause`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);

  const single = await client.webhooks.test(later.id).catch((error: unknown) => error);
  expect(single).toBeInstanceOf(TaskFlowError);
  expect((single as TaskFlowError).code).toBe("WEBHOOK_DISABLED");
});
