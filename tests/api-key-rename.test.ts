import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
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

it("renames an API key without changing the secret", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.rename@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Keys", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    description: "Jobs",
    scopes: ["jobs:read", "jobs:write"],
  });
  expect(created.status).toBe(201);
  const keyId = created.body.data.id as string;
  const prefix = created.body.data.prefix as string;
  const secret = created.body.data.secret as string;
  const before = await ApiKey.findOne({ publicId: keyId }).select("+keyHash");
  const hash = before?.keyHash;

  const renamed = await asAda(ada.patch(`/api/v1/projects/${projectId}/api-keys/${keyId}`)).send({
    name: "reader",
    description: "Read jobs",
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.data.id).toBe(keyId);
  expect(renamed.body.data.name).toBe("reader");
  expect(renamed.body.data.description).toBe("Read jobs");
  expect(renamed.body.data.prefix).toBe(prefix);
  expect(renamed.body.data.scopes).toEqual(["jobs:read", "jobs:write"]);
  expect(renamed.body.data).not.toHaveProperty("secret");
  const after = await ApiKey.findOne({ publicId: keyId }).select("+keyHash");
  expect(after?.keyHash).toBe(hash);

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const listed = await client.jobs.list();
  expect(listed.data).toEqual([]);

  const short = await asAda(ada.patch(`/api/v1/projects/${projectId}/api-keys/${keyId}`)).send({ name: "a" });
  expect(short.status).toBe(400);
  expect(short.body.error.code).toBe("VALIDATION_ERROR");

  const revoked = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/${keyId}/revoke`)).send({});
  expect(revoked.status).toBe(200);
  const frozen = await asAda(ada.patch(`/api/v1/projects/${projectId}/api-keys/${keyId}`)).send({ name: "archive" });
  expect(frozen.status).toBe(409);
  expect(frozen.body.error.code).toBe("API_KEY_REVOKED");

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.rename@example.com",
    password,
  });
  expect(grace.status).toBe(201);
  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.rename@example.com" });
  expect(invited.status).toBe(201);
  const member = await request(server)
    .patch(`/api/v1/projects/${projectId}/api-keys/${keyId}`)
    .send({ name: "taken" })
    .set("Authorization", `Bearer ${grace.body.data.accessToken}`);
  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe("OWNER_REQUIRED");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.rename@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}/api-keys/${keyId}`)
    .send({ name: "taken" })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
