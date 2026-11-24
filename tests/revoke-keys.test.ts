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

it("revokes the oldest active and expired API keys and leaves an already revoked key alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.revoke-keys@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Keys", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, expiresInDays?: number) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
      name,
      scopes: ["jobs:read", "jobs:write"],
      ...(expiresInDays ? { expiresInDays } : {}),
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; prefix: string; secret: string; status: string };
  }

  const oldest = await create("Morning key");
  const later = await create("Evening key");
  const expired = await create("Expired key", 1);
  const held = await create("Held key");
  await ApiKey.updateOne({ publicId: expired.id }, { expiresAt: new Date(Date.now() - 60_000) });
  const listedBefore = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const before = listedBefore.body.data as { id: string; status: string; prefix: string }[];
  expect(before.find((key) => key.id === expired.id)?.status).toBe("expired");
  const revokedHeld = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/${held.id}/revoke`)).send({});
  expect(revokedHeld.status).toBe(200);
  const oldestHash = (await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash"))?.keyHash;

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/revoke`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/revoke`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/revoke`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data.revoked).toBe(1);
  expect(first.body.data.skipped).toBe(0);
  expect(first.body.data.keyIds).toEqual([oldest.id]);
  const afterFirst = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const keys = afterFirst.body.data as { id: string; status: string; prefix: string; secret?: string }[];
  const oldestListed = keys.find((key) => key.id === oldest.id);
  expect(oldestListed?.status).toBe("revoked");
  expect(oldestListed?.prefix).toBe(oldest.prefix);
  expect(oldestListed?.secret).toBeUndefined();
  expect(keys.find((key) => key.id === later.id)?.status).toBe("active");
  expect(keys.find((key) => key.id === expired.id)?.status).toBe("expired");
  expect(keys.find((key) => key.id === held.id)?.status).toBe("revoked");
  expect((await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash"))?.keyHash).toBe(oldestHash);

  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/revoke`)
    .set("Authorization", `Bearer ${later.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("OWNER_REQUIRED");

  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/revoke`)).send({ limit: 20 });
  expect(second.status).toBe(200);
  expect(second.body.data.revoked).toBe(2);
  expect(second.body.data.skipped).toBe(0);
  expect(second.body.data.keyIds).toEqual([later.id, expired.id]);
  const afterSecond = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const secondKeys = afterSecond.body.data as { id: string; status: string; prefix: string }[];
  expect(secondKeys.find((key) => key.id === later.id)?.status).toBe("revoked");
  expect(secondKeys.find((key) => key.id === later.id)?.prefix).toBe(later.prefix);
  expect(secondKeys.find((key) => key.id === expired.id)?.status).toBe("revoked");
  expect(secondKeys.find((key) => key.id === expired.id)?.prefix).toBe(expired.prefix);

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/revoke`)).send({ limit: 20 });
  expect(again.status).toBe(200);
  expect(again.body.data).toEqual({ revoked: 0, skipped: 0, keyIds: [] });

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.revoke-keys@example.com",
    password,
  });
  expect(grace.status).toBe(201);
  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.revoke-keys@example.com" });
  expect(invited.status).toBe(201);
  const member = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/revoke`)
    .set("Authorization", `Bearer ${grace.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe("OWNER_REQUIRED");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.revoke-keys@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/revoke`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
