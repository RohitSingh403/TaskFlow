import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { JobRecord } from "@taskflow/server";
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

it("takes a failed job off the dead letter list and puts it back", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.dismiss@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Dead letter", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  const emails = (queues.body.data as { id: string; name: string }[]).find((queue) => queue.name === "emails");
  if (!emails) throw new Error("Emails queue was not created");
  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${emails.id}/pause`)).send({});
  expect(paused.status).toBe(200);

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

  async function submit(subject: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue: "emails",
      name: "send-email",
      payload: { to: "user@example.com", subject, body: "Hello" },
      maxAttempts: 1,
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const first = await submit("Welcome");
  const second = await submit("Receipt");
  const waiting = await client.jobs.dismiss(first).catch((error: unknown) => error);
  expect(waiting).toMatchObject({ status: 409, code: "JOB_NOT_DISMISSIBLE" });

  await JobRecord.updateMany(
    { publicId: { $in: [first, second] } },
    { status: "failed", completedAt: new Date(), error: { message: "Provider timed out" } },
  );

  const dismissed = await client.jobs.dismiss(first);
  expect(dismissed.data.id).toBe(first);
  expect(dismissed.data.status).toBe("failed");
  expect(dismissed.data.dismissedAt).toEqual(expect.any(String));

  const open = await client.jobs.list({ status: "failed", dismissed: false });
  expect(open.data.map((job) => job.id)).toEqual([second]);
  const hidden = await client.jobs.list({ status: "failed", dismissed: true });
  expect(hidden.data.map((job) => job.id)).toEqual([first]);

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${first}/dismiss`)).send({});
  expect(again.status).toBe(409);
  expect(again.body.error.code).toBe("JOB_NOT_DISMISSIBLE");

  const retried = await client.jobs.retryFailed({ queue: "emails" });
  expect(retried.data.retried).toBe(1);
  expect(retried.data.jobIds).toEqual([second]);
  const stillDismissed = await client.jobs.get(first);
  expect(stillDismissed.data.status).toBe("failed");
  expect(stillDismissed.data.dismissedAt).toEqual(expect.any(String));

  const restored = await client.jobs.restore(first);
  expect(restored.data.dismissedAt).toBeNull();
  const listed = await client.jobs.list({ status: "failed", dismissed: false });
  expect(listed.data.map((job) => job.id)).toEqual([first]);

  const early = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/${first}/restore`)).send({});
  expect(early.status).toBe(409);
  expect(early.body.error.code).toBe("JOB_NOT_DISMISSIBLE");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.dismiss@example.com",
    password,
  });
  const blocked = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/${first}/dismiss`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(blocked.status).toBe(404);
});
