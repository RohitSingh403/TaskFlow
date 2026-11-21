import { createServer, type Server } from "node:http";
import { ApiKey } from "@taskflow/server";
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

it("rejects an expired API key and leaves a key with no expiry usable", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.keys@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Keys", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const invalid = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "too soon",
    scopes: ["jobs:read"],
    expiresInDays: 0,
  });
  expect(invalid.status).toBe(400);

  const lasting = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "lasting",
    scopes: ["jobs:read"],
  });
  expect(lasting.status).toBe(201);
  expect(lasting.body.data.expiresAt).toBeNull();
  expect(lasting.body.data.secret.startsWith("tf_live_")).toBe(true);

  const temporary = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "temporary",
    scopes: ["jobs:read"],
    expiresInDays: 7,
  });
  expect(temporary.status).toBe(201);
  const expiresAt = new Date(temporary.body.data.expiresAt as string).getTime();
  expect(expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  expect(expiresAt).toBeLessThan(Date.now() + 8 * 86_400_000);

  const usable = await request(server)
    .get(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${temporary.body.data.secret}`);
  expect(usable.status).toBe(200);

  await ApiKey.updateOne({ publicId: temporary.body.data.id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  const expired = await request(server)
    .get(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${temporary.body.data.secret}`);
  expect(expired.status).toBe(401);
  expect(expired.body.error.code).toBe("API_KEY_EXPIRED");

  const still = await request(server)
    .get(`/api/v1/projects/${projectId}/jobs`)
    .set("Authorization", `Bearer ${lasting.body.data.secret}`);
  expect(still.status).toBe(200);

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const row = listed.body.data.find((key: { id: string }) => key.id === temporary.body.data.id);
  expect(row.status).toBe("expired");
  const open = listed.body.data.find((key: { id: string }) => key.id === lasting.body.data.id);
  expect(open.status).toBe("active");
  expect(open.expiresAt).toBeNull();
});
