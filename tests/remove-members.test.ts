import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { ProjectMember } from "@taskflow/server";
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

it("removes the oldest members, keeps the owner, and leaves someone who already left alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.remove-members@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  async function register(name: string, email: string) {
    const created = await request(server).post("/api/v1/auth/register").send({ name, email, password });
    expect(created.status).toBe(201);
    return created.body.data.accessToken as string;
  }

  const graceToken = await register("Grace Hopper", "grace.remove-members@example.com");
  const katherineToken = await register("Katherine Johnson", "katherine.remove-members@example.com");
  await register("Margaret Hamilton", "margaret.remove-members@example.com");
  const dorothyToken = await register("Dorothy Vaughan", "dorothy.remove-members@example.com");

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Shared", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function invite(email: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; email: string; name: string; role: string };
  }

  const grace = await invite("grace.remove-members@example.com");
  const katherine = await invite("katherine.remove-members@example.com");
  const margaret = await invite("margaret.remove-members@example.com");
  const dorothy = await invite("dorothy.remove-members@example.com");
  const removed = await asAda(ada.delete(`/api/v1/projects/${projectId}/members/${margaret.id}`));
  expect(removed.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write"] });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.members.removeMembers({ limit: 1 })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  await expect(writing.members.removeMembers({ limit: 1 })).rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });

  const asDorothy = (call: request.Test) => call.set("Authorization", `Bearer ${dorothyToken}`);
  const refused = await asDorothy(request(server).post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 1 });
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("OWNER_REQUIRED");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ removed: 1, skipped: 0, memberIds: [grace.id] });
  const storedGrace = await ProjectMember.findOne({ publicId: grace.id });
  expect(storedGrace?.deletedAt).toBeInstanceOf(Date);
  expect(storedGrace?.email).toBe("grace.remove-members@example.com");
  expect(storedGrace?.name).toBe("Grace Hopper");
  const graceGone = await request(server).get(`/api/v1/projects/${projectId}/members`).set("Authorization", `Bearer ${graceToken}`);
  expect(graceGone.status).toBe(404);

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/members`));
  expect(listed.body.data.members.map((member: { email: string; role: string }) => `${member.email}:${member.role}`)).toEqual([
    "ada.remove-members@example.com:owner",
    "katherine.remove-members@example.com:member",
    "dorothy.remove-members@example.com:member",
  ]);

  const second = await asAda(ada.post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 20 });
  expect(second.status).toBe(200);
  expect(second.body.data).toEqual({ removed: 2, skipped: 0, memberIds: [katherine.id, dorothy.id] });
  const storedKatherine = await ProjectMember.findOne({ publicId: katherine.id });
  expect(storedKatherine?.deletedAt).toBeInstanceOf(Date);
  expect(storedKatherine?.email).toBe("katherine.remove-members@example.com");
  const katherineGone = await request(server).get(`/api/v1/projects/${projectId}/members`).set("Authorization", `Bearer ${katherineToken}`);
  expect(katherineGone.status).toBe(404);
  const owner = await asAda(ada.get(`/api/v1/projects/${projectId}/members`));
  expect(owner.body.data.role).toBe("owner");
  expect(owner.body.data.members).toEqual([
    {
      id: expect.any(String),
      userId: expect.any(String),
      name: "Ada Lovelace",
      email: "ada.remove-members@example.com",
      role: "owner",
    },
  ]);

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/members/remove`)).send({ limit: 20 });
  expect(again.body.data).toEqual({ removed: 0, skipped: 0, memberIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Mary Jackson",
    email: "mary.remove-members@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/members/remove`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
