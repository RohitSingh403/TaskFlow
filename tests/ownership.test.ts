import { createServer, type Server } from "node:http";
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

it("transfers a project to a member and keeps the previous owner on the team", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.owner@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const adaToken = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${adaToken}`);

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.owner@example.com",
    password,
  });
  const graceToken = grace.body.data.accessToken as string;
  const asGrace = (call: request.Test) => call.set("Authorization", `Bearer ${graceToken}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Handoff", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.owner@example.com" });
  expect(invited.status).toBe(201);
  const memberId = invited.body.data.id as string;

  const blocked = await asGrace(request(server).post(`/api/v1/projects/${projectId}/members/transfer`)).send({ memberId });
  expect(blocked.status).toBe(403);

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/members/transfer`)).send({ memberId: "mem_missing" });
  expect(missing.status).toBe(404);

  const transferred = await asAda(ada.post(`/api/v1/projects/${projectId}/members/transfer`)).send({ memberId });
  expect(transferred.status).toBe(200);
  expect(transferred.body.data.ownerId).toBe(invited.body.data.userId);

  const adaView = await asAda(ada.get(`/api/v1/projects/${projectId}/members`));
  expect(adaView.body.data.role).toBe("member");
  const graceView = await asGrace(request(server).get(`/api/v1/projects/${projectId}/members`));
  expect(graceView.body.data.role).toBe("owner");
  expect(graceView.body.data.members.map((item: { email: string; role: string }) => `${item.email}:${item.role}`)).toEqual([
    "grace.owner@example.com:owner",
    "ada.owner@example.com:member",
  ]);

  const adaSettings = await asAda(ada.patch(`/api/v1/projects/${projectId}/billing`)).send({ plan: "scale" });
  expect(adaSettings.status).toBe(403);
  const graceSettings = await asGrace(request(server).patch(`/api/v1/projects/${projectId}/billing`)).send({ plan: "scale" });
  expect(graceSettings.status).toBe(200);

  const left = await asAda(ada.post(`/api/v1/projects/${projectId}/members/leave`)).send({});
  expect(left.status).toBe(200);
  const gone = await asAda(ada.get(`/api/v1/projects/${projectId}/members`));
  expect(gone.status).toBe(404);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.owner@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/members/transfer`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ memberId });
  expect(hidden.status).toBe(404);
});
