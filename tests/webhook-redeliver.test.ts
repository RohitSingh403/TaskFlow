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

it("queues the same delivery again and leaves a pending delivery alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.redeliver@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Redeliver", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: "http://127.0.0.1:9/hook",
    description: "Local",
    events: ["job.completed"],
  });
  expect(created.status).toBe(201);
  const webhookId = created.body.data.id as string;
  const storedProject = await Project.findOne({ publicId: projectId });
  if (!storedProject) throw new Error("Project was not stored");
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_redeliver_failed",
    data: { jobId: "job_redeliver_failed", status: "completed" },
  });
  await dispatchWebhooks({
    projectId: storedProject._id,
    event: "job.completed",
    resourceId: "job_redeliver_ok",
    data: { jobId: "job_redeliver_ok", status: "completed" },
  });
  const failed = await WebhookDelivery.findOne({ resourceId: "job_redeliver_failed" });
  const succeeded = await WebhookDelivery.findOne({ resourceId: "job_redeliver_ok" });
  if (!failed || !succeeded) throw new Error("Deliveries were not recorded");

  const pending = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${failed.publicId}/redeliver`));
  expect(pending.status).toBe(409);
  expect(pending.body.error.code).toBe("DELIVERY_PENDING");

  await WebhookDelivery.collection.updateOne({ publicId: failed.publicId }, { $set: { status: "failed", completedAt: new Date() } });
  await WebhookDelivery.collection.updateOne({ publicId: succeeded.publicId }, { $set: { status: "succeeded", completedAt: new Date() } });

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
  await expect(reading.webhooks.redeliver(webhookId, failed.publicId)).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const again = await writing.webhooks.redeliver(webhookId, failed.publicId);
  expect(again.data.id).toBe(failed.publicId);
  expect(again.data.status).toBe("pending");
  expect(again.data.completedAt).toBeNull();
  expect(await getBullQueue(WEBHOOK_QUEUE).getJob(failed.publicId).then((job) => job?.getState())).toBe("waiting");

  const duplicate = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${failed.publicId}/redeliver`));
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("DELIVERY_PENDING");

  const resent = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${succeeded.publicId}/redeliver`));
  expect(resent.status).toBe(200);
  expect(resent.body.data.id).toBe(succeeded.publicId);
  expect(resent.body.data.status).toBe("pending");

  await WebhookDelivery.collection.updateOne({ publicId: succeeded.publicId }, { $set: { status: "failed" } });
  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${webhookId}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${succeeded.publicId}/redeliver`));
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("WEBHOOK_DISABLED");

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/whd_missing/redeliver`));
  expect(missing.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.redeliver@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${failed.publicId}/redeliver`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
