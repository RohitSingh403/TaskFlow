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

it("lets an owner add a member, and keeps owner-only actions with the owner", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.members@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const adaToken = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${adaToken}`);

  const grace = await request(server).post("/api/v1/auth/register").send({
    name: "Grace Hopper",
    email: "grace.members@example.com",
    password,
  });
  expect(grace.status).toBe(201);
  const graceToken = grace.body.data.accessToken as string;
  const asGrace = (call: request.Test) => call.set("Authorization", `Bearer ${graceToken}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Shared", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "nobody@example.com" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("USER_NOT_FOUND");

  const ownerInvite = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "ada.members@example.com" });
  expect(ownerInvite.status).toBe(409);

  const invited = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "Grace.Members@example.com" });
  expect(invited.status).toBe(201);
  expect(invited.body.data.role).toBe("member");
  const duplicate = await asAda(ada.post(`/api/v1/projects/${projectId}/members`)).send({ email: "grace.members@example.com" });
  expect(duplicate.status).toBe(409);

  const visible = await asGrace(request(server).get("/api/v1/projects"));
  expect(visible.body.data.map((item: { id: string }) => item.id)).toContain(projectId);

  const submitted = await asGrace(request(server).post(`/api/v1/projects/${projectId}/jobs`)).send({
    queue: "emails",
    name: "send-email",
    payload: { to: "user@example.com", subject: "Welcome", body: "Glad you are here." },
  });
  expect(submitted.status).toBe(201);

  const keys = await asGrace(request(server).post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "member key" });
  expect(keys.status).toBe(403);
  const deleted = await asGrace(request(server).delete(`/api/v1/projects/${projectId}`));
  expect(deleted.status).toBe(403);
  expect(deleted.body.error.code).toBe("OWNER_REQUIRED");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.members@example.com",
    password,
  });
  const hidden = await request(server)
    .get(`/api/v1/projects/${projectId}/members`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);

  const removed = await asAda(ada.delete(`/api/v1/projects/${projectId}/members/${invited.body.data.id}`));
  expect(removed.status).toBe(200);
  const gone = await asGrace(request(server).get(`/api/v1/projects/${projectId}/jobs`));
  expect(gone.status).toBe(404);
});
