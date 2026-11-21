import { createServer, type Server } from "node:http";
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

it("queues a signed test delivery and rejects a disabled endpoint", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.webhook@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Hooks", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks`)).send({
    url: "http://127.0.0.1:9/hooks",
    events: ["job.completed"],
  });
  expect(created.status).toBe(201);
  const webhookId = created.body.data.id as string;

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:write", "jobs:read"],
  });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });

  const first = await client.webhooks.test(webhookId);
  const second = await client.webhooks.test(webhookId);
  expect(first.data.event).toBe("webhook.test");
  expect(first.data.status).toBe("pending");
  expect(first.data.resourceId).toBe(first.data.id);
  expect(second.data.id).not.toBe(first.data.id);

  const paused = await asAda(ada.patch(`/api/v1/projects/${projectId}/webhooks/${webhookId}`)).send({ enabled: false });
  expect(paused.status).toBe(200);
  const blocked = await asAda(ada.post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/test`));
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("WEBHOOK_DISABLED");

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/webhooks`));
  const tests = (listed.body.data.deliveries as { event: string }[]).filter((delivery) => delivery.event === "webhook.test");
  expect(tests).toHaveLength(2);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.webhook@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/webhooks/${webhookId}/test`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
