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
const payload = { to: "user@example.com", subject: "Welcome", body: "Hello" };

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

it("cancels waiting and delayed jobs on one queue and leaves the other queue queued", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.cancel@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Cancel", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  const key = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "reader",
    scopes: ["jobs:read"],
  });
  expect(key.status).toBe(201);

  async function submit(queue: string, delayMs = 0) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: queue === "reports" ? "generate-report" : "send-email",
      payload: queue === "reports" ? { reportType: "sales", format: "pdf", rangeDays: 7 } : payload,
      ...(delayMs ? { delayMs } : {}),
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const waitingId = await submit("emails");
  const delayedId = await submit("emails", 60_000);
  const otherId = await submit("reports");

  const missing = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/cancel-queued`)).send({ queue: "missing-queue" });
  expect(missing.status).toBe(404);

  const forbidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/cancel-queued`)
    .set("Authorization", `Bearer ${key.body.data.secret}`)
    .send({ queue: "emails", limit: 20 });
  expect(forbidden.status).toBe(403);

  const client = new TaskFlow({ apiKey: key.body.data.secret, baseUrl: serverAddress(server), projectId });
  await expect(client.jobs.cancelQueued({ queue: "emails" })).rejects.toMatchObject({ status: 403 });

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:read", "jobs:write"],
  });
  expect(writer.status).toBe(201);
  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl: serverAddress(server), projectId });
  const cancelled = await writing.jobs.cancelQueued({ queue: "emails", limit: 20 });
  expect(cancelled.data.cancelled).toBe(2);
  expect(cancelled.data.jobIds.sort()).toEqual([waitingId, delayedId].sort());

  const waiting = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${waitingId}`));
  const delayed = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${delayedId}`));
  const other = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${otherId}`));
  expect(waiting.body.data.status).toBe("cancelled");
  expect(delayed.body.data.status).toBe("cancelled");
  expect(other.body.data.status).toBe("waiting");

  const again = await writing.jobs.cancelQueued({ queue: "emails", limit: 20 });
  expect(again.data.cancelled).toBe(0);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.cancel@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/cancel-queued`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 5 });
  expect(hidden.status).toBe(404);
});

function serverAddress(httpServer: Server) {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  return `http://127.0.0.1:${address.port}/api/v1`;
}
