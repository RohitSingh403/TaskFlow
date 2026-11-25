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
const day = 86_400_000;

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

it("extends the oldest keys that already expire, including an expired key, and leaves the others alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.extend-keys@example.com",
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
    return created.body.data as { id: string; prefix: string; secret: string; name: string };
  }

  const oldest = await create("Morning key", 1);
  const later = await create("Evening key", 2);
  const forever = await create("Standing key");
  const expired = await create("Expired key", 1);
  const held = await create("Held key", 3);
  await ApiKey.updateOne({ publicId: expired.id }, { expiresAt: new Date(Date.now() - 60_000) });
  const revoked = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/${held.id}/revoke`)).send({});
  expect(revoked.status).toBe(200);
  const oldestHash = (await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash"))?.keyHash;
  const heldExpiry = (await ApiKey.findOne({ publicId: held.id }))?.expiresAt?.getTime();

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 30, limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 30, limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const tooSoon = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 0, limit: 1 });
  expect(tooSoon.status).toBe(400);
  expect(tooSoon.body.error.code).toBe("VALIDATION_ERROR");
  const tooFar = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 366, limit: 1 });
  expect(tooFar.status).toBe(400);
  expect(tooFar.body.error.code).toBe("VALIDATION_ERROR");

  const started = Date.now();
  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 30, limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ extended: 1, skipped: 0, keyIds: [oldest.id] });
  const storedOldest = await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash");
  expect(storedOldest?.keyHash).toBe(oldestHash);
  expect(storedOldest?.prefix).toBe(oldest.prefix);
  expect(storedOldest?.name).toBe("Morning key");
  expect(storedOldest?.scopes).toEqual(["jobs:read", "jobs:write"]);
  expect(storedOldest?.revokedAt).toBeUndefined();
  const oldestExpiry = storedOldest?.expiresAt?.getTime() ?? 0;
  expect(oldestExpiry).toBeGreaterThanOrEqual(started + 30 * day - 5_000);
  expect(oldestExpiry).toBeLessThanOrEqual(Date.now() + 30 * day + 5_000);
  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const keys = listed.body.data as { id: string; status: string; prefix: string; secret?: string; expiresAt: string | null }[];
  expect(keys.find((key) => key.id === oldest.id)?.status).toBe("active");
  expect(keys.find((key) => key.id === oldest.id)?.secret).toBeUndefined();
  expect(keys.find((key) => key.id === forever.id)?.expiresAt).toBeNull();
  expect(keys.find((key) => key.id === held.id)?.status).toBe("revoked");
  expect(keys.find((key) => key.id === expired.id)?.status).toBe("expired");

  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/extend`)
    .set("Authorization", `Bearer ${oldest.secret}`)
    .send({ expiresInDays: 30, limit: 20 });
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("OWNER_REQUIRED");

  const secondStarted = Date.now();
  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 30, limit: 20 });
  expect(second.status).toBe(200);
  expect(second.body.data).toEqual({ extended: 3, skipped: 0, keyIds: [oldest.id, later.id, expired.id] });
  const storedExpired = await ApiKey.findOne({ publicId: expired.id });
  const expiredAt = storedExpired?.expiresAt?.getTime() ?? 0;
  expect(expiredAt).toBeGreaterThanOrEqual(secondStarted + 30 * day - 5_000);
  expect(expiredAt).toBeLessThanOrEqual(Date.now() + 30 * day + 5_000);
  const storedLater = await ApiKey.findOne({ publicId: later.id });
  expect(storedLater?.name).toBe("Evening key");
  expect(storedLater?.prefix).toBe(later.prefix);
  expect(storedLater?.expiresAt?.getTime()).toBeGreaterThanOrEqual(secondStarted + 30 * day - 5_000);
  const storedForever = await ApiKey.findOne({ publicId: forever.id });
  expect(storedForever?.expiresAt ?? null).toBeNull();
  const storedHeld = await ApiKey.findOne({ publicId: held.id });
  expect(storedHeld?.revokedAt).toBeInstanceOf(Date);
  expect(storedHeld?.expiresAt?.getTime()).toBe(heldExpiry);
  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const afterKeys = after.body.data as { id: string; status: string }[];
  expect(afterKeys.find((key) => key.id === expired.id)?.status).toBe("active");

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/extend`)).send({ expiresInDays: 30, limit: 20 });
  expect(again.body.data).toEqual({ extended: 3, skipped: 0, keyIds: [oldest.id, later.id, expired.id] });

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.extend-keys@example.com",
    password,
  });
  expect(grace.status).toBe(201);
  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.extend-keys@example.com" });
  expect(invited.status).toBe(201);
  const member = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/extend`)
    .set("Authorization", `Bearer ${grace.body.data.accessToken}`)
    .send({ expiresInDays: 30, limit: 1 });
  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe("OWNER_REQUIRED");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.extend-keys@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/extend`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ expiresInDays: 30, limit: 1 });
  expect(hidden.status).toBe(404);
});
