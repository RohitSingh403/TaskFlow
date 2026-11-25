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

it("replaces the scopes on the oldest keys, keeps an expired key's date, and leaves a matching or revoked key alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.set-scopes@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Keys", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, scopes: string[]) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
      name,
      scopes,
      expiresInDays: 30,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; prefix: string; secret: string };
  }

  const oldest = await create("Morning key", ["jobs:write"]);
  const later = await create("Evening key", ["analytics:read"]);
  const matching = await create("Reader key", ["jobs:read"]);
  const expired = await create("Expired key", ["logs:read"]);
  const held = await create("Held key", ["jobs:write"]);
  const expiredAt = new Date(Date.now() - 60_000);
  await ApiKey.updateOne({ publicId: expired.id }, { expiresAt: expiredAt });
  const revoked = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/${held.id}/revoke`)).send({});
  expect(revoked.status).toBe(200);
  const oldestHash = (await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash"))?.keyHash;
  const oldestExpiry = (await ApiKey.findOne({ publicId: oldest.id }))?.expiresAt?.getTime();

  const empty = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: [], limit: 1 });
  expect(empty.status).toBe(400);
  expect(empty.body.error.code).toBe("VALIDATION_ERROR");
  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["nope"], limit: 1 });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.code).toBe("VALIDATION_ERROR");
  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["jobs:read"], limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["jobs:read"], limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["jobs:read", "jobs:read"], limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ updated: 1, skipped: 0, keyIds: [oldest.id] });
  const storedOldest = await ApiKey.findOne({ publicId: oldest.id }).select("+keyHash");
  expect(storedOldest?.keyHash).toBe(oldestHash);
  expect(storedOldest?.prefix).toBe(oldest.prefix);
  expect(storedOldest?.name).toBe("Morning key");
  expect(storedOldest?.scopes).toEqual(["jobs:read"]);
  expect(storedOldest?.expiresAt?.getTime()).toBe(oldestExpiry);
  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  const keys = listed.body.data as { id: string; scopes: string[]; status: string; secret?: string }[];
  expect(keys.find((key) => key.id === oldest.id)?.scopes).toEqual(["jobs:read"]);
  expect(keys.find((key) => key.id === oldest.id)?.secret).toBeUndefined();
  expect(keys.find((key) => key.id === later.id)?.scopes).toEqual(["analytics:read"]);
  expect(keys.find((key) => key.id === held.id)?.status).toBe("revoked");
  expect(keys.find((key) => key.id === expired.id)?.status).toBe("expired");

  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/scopes`)
    .set("Authorization", `Bearer ${oldest.secret}`)
    .send({ scopes: ["jobs:read"], limit: 20 });
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("OWNER_REQUIRED");

  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["jobs:read"], limit: 20 });
  expect(second.status).toBe(200);
  expect(second.body.data).toEqual({ updated: 2, skipped: 2, keyIds: [later.id, expired.id] });
  const storedExpired = await ApiKey.findOne({ publicId: expired.id });
  expect(storedExpired?.scopes).toEqual(["jobs:read"]);
  expect(storedExpired?.expiresAt?.getTime()).toBe(expiredAt.getTime());
  const storedLater = await ApiKey.findOne({ publicId: later.id });
  expect(storedLater?.name).toBe("Evening key");
  expect(storedLater?.prefix).toBe(later.prefix);
  expect(storedLater?.scopes).toEqual(["jobs:read"]);
  const storedHeld = await ApiKey.findOne({ publicId: held.id });
  expect(storedHeld?.revokedAt).toBeInstanceOf(Date);
  expect(storedHeld?.scopes).toEqual(["jobs:write"]);
  const after = await asAda(ada.get(`/api/v1/projects/${projectId}/api-keys`));
  expect((after.body.data as { id: string; status: string }[]).find((key) => key.id === expired.id)?.status).toBe("expired");

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys/scopes`)).send({ scopes: ["jobs:read"], limit: 20 });
  expect(again.body.data).toEqual({ updated: 0, skipped: 4, keyIds: [] });

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.set-scopes@example.com",
    password,
  });
  expect(grace.status).toBe(201);
  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.set-scopes@example.com" });
  expect(invited.status).toBe(201);
  const member = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/scopes`)
    .set("Authorization", `Bearer ${grace.body.data.accessToken}`)
    .send({ scopes: ["jobs:read"], limit: 1 });
  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe("OWNER_REQUIRED");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.set-scopes@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/api-keys/scopes`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ scopes: ["jobs:read"], limit: 1 });
  expect(hidden.status).toBe(404);
});
