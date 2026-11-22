import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { WEBHOOK_QUEUE } from "@taskflow/shared";
import { Project, WebhookDelivery, dispatchWebhooks, getBullQueue } from "@taskflow/server";
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

it("queues the oldest failed webhook deliveries again and keeps their ids", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.redeliver-failed@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Deliveries", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: "http://127.0.0.1:9/hook",
    description: "Primary",
    events: ["job.completed"],
  });
  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: "http://127.0.0.1:9/other",
    description: "Paused",
    events: ["job.failed"],
  });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const webhookId = first.body.data.id as string;
  const pausedId = second.body.data.id as string;
  const storedProject = await Project.findOne({ publicId: projectId });
  if (!storedProject) throw new Error("Project was not stored");

  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_old_failed",
    data: { jobId: "job_old_failed", status: "completed" },
  });
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_new_failed",
    data: { jobId: "job_new_failed", status: "completed" },
  });
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_ok",
    data: { jobId: "job_ok", status: "completed" },
  });
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_waiting",
    data: { jobId: "job_waiting", status: "completed" },
  });
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.failed",
    resourceId: "job_paused",
    data: { jobId: "job_paused", status: "failed" },
  });

  const oldFailed = await WebhookDelivery.findOne({ resourceId: "job_old_failed" });
  const newFailed = await WebhookDelivery.findOne({ resourceId: "job_new_failed" });
  const succeeded = await WebhookDelivery.findOne({ resourceId: "job_ok" });
  const pending = await WebhookDelivery.findOne({ resourceId: "job_waiting" });
  const paused = await WebhookDelivery.findOne({ resourceId: "job_paused" });
  if (!oldFailed || !newFailed || !succeeded || !pending || !paused) throw new Error("Deliveries were not recorded");
  await WebhookDelivery.collection.updateOne({ publicId: oldFailed.publicId }, { $set: { status: "failed", createdAt: new Date("2020-01-01T00:00:00Z") } });
  await WebhookDelivery.collection.updateOne({ publicId: newFailed.publicId }, { $set: { status: "failed", createdAt: new Date("2020-01-02T00:00:00Z") } });
  await WebhookDelivery.collection.updateOne({ publicId: succeeded.publicId }, { $set: { status: "succeeded", completedAt: new Date() } });
  await WebhookDelivery.collection.updateOne({ publicId: paused.publicId }, { $set: { status: "failed", createdAt: new Date("2020-01-03T00:00:00Z") } });

  const pausedEndpoint = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${pausedId}`)).send({ enabled: false });
  expect(pausedEndpoint.status).toBe(200);
  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ webhookId: pausedId, limit: 20 });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("WEBHOOK_DISABLED");
  expect((await WebhookDelivery.findOne({ publicId: paused.publicId }))?.status).toBe("failed");

  const limited = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ webhookId, limit: 1 });
  expect(limited.status).toBe(200);
  expect(limited.body.data).toEqual({ redelivered: 1, skipped: 0, deliveryIds: [oldFailed.publicId] });
  expect((await WebhookDelivery.findOne({ publicId: oldFailed.publicId }))?.status).toBe("pending");
  expect((await WebhookDelivery.findOne({ publicId: newFailed.publicId }))?.status).toBe("failed");
  expect(await getBullQueue(WEBHOOK_QUEUE).getJob(oldFailed.publicId).then((job) => job?.getState())).toBe("waiting");

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
  await expect(reading.webhooks.redeliverFailed({ webhookId })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const rest = await writing.webhooks.redeliverFailed({ limit: 20 });
  expect(rest.data.redelivered).toBe(1);
  expect(rest.data.skipped).toBe(1);
  expect(rest.data.deliveryIds).toEqual([newFailed.publicId]);
  expect((await WebhookDelivery.findOne({ publicId: newFailed.publicId }))?.status).toBe("pending");
  expect((await WebhookDelivery.findOne({ publicId: succeeded.publicId }))?.status).toBe("succeeded");
  expect((await WebhookDelivery.findOne({ publicId: pending.publicId }))?.status).toBe("pending");
  expect((await WebhookDelivery.findOne({ publicId: paused.publicId }))?.status).toBe("failed");

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ webhookId, limit: 20 });
  expect(again.status).toBe(200);
  expect(again.body.data).toEqual({ redelivered: 0, skipped: 0, deliveryIds: [] });

  const zero = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ limit: 0 });
  expect(zero.status).toBe(400);
  expect(zero.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)).send({ webhookId: "wh_missing" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("WEBHOOK_NOT_FOUND");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.redeliver-failed@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/redeliver-failed`)
    .send({ limit: 1 })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
