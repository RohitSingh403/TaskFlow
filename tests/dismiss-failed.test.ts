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

it("dismisses the oldest failed jobs and leaves the rest of the list", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.dismissfailed@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Dead letter", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  for (const queue of queues.body.data as { id: string; name: string }[]) {
    if (queue.name === "emails" || queue.name === "reports") {
      const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${queue.id}/pause`)).send({});
      expect(paused.status).toBe(200);
    }
  }

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

  async function submit(queue: string, subject: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs`)).send({
      queue,
      name: queue === "reports" ? "generate-report" : "send-email",
      payload: queue === "reports"
        ? { reportType: "activity", format: "pdf", rangeDays: 7 }
        : { to: "user@example.com", subject, body: "Hello" },
      maxAttempts: 1,
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  const older = await submit("emails", "Welcome");
  const newer = await submit("emails", "Receipt");
  const report = await submit("reports", "Activity");
  const waiting = await submit("emails", "Still queued");
  await JobRecord.collection.updateOne(
    { publicId: older },
    { $set: { status: "failed", updatedAt: new Date("2020-01-01T00:00:00Z"), completedAt: new Date("2020-01-01T00:00:00Z"), error: { message: "Provider timed out" } } },
  );
  await JobRecord.collection.updateOne(
    { publicId: newer },
    { $set: { status: "failed", updatedAt: new Date("2020-02-01T00:00:00Z"), completedAt: new Date("2020-02-01T00:00:00Z"), error: { message: "Provider timed out" } } },
  );
  await JobRecord.collection.updateOne(
    { publicId: report },
    { $set: { status: "failed", updatedAt: new Date("2020-01-15T00:00:00Z"), completedAt: new Date("2020-01-15T00:00:00Z"), error: { message: "Renderer unavailable" } } },
  );

  const first = await client.jobs.dismissFailed({ queue: "emails", limit: 1 });
  expect(first.data.dismissed).toBe(1);
  expect(first.data.jobIds).toEqual([older]);
  const hidden = await client.jobs.get(older);
  expect(hidden.data.id).toBe(older);
  expect(hidden.data.status).toBe("failed");
  expect(hidden.data.dismissedAt).toEqual(expect.any(String));

  const open = await client.jobs.list({ status: "failed", queue: "emails", dismissed: false });
  expect(open.data.map((job) => job.id)).toEqual([newer]);
  const stillWaiting = await client.jobs.get(waiting);
  expect(stillWaiting.data.status).toBe("waiting");
  expect(stillWaiting.data.dismissedAt).toBeNull();

  const rest = await client.jobs.dismissFailed({ queue: "emails" });
  expect(rest.data.jobIds).toEqual([newer]);
  const again = await client.jobs.dismissFailed({ queue: "emails" });
  expect(again.data).toMatchObject({ dismissed: 0, skipped: 0, jobIds: [] });

  const reportStillOpen = await client.jobs.list({ status: "failed", queue: "reports", dismissed: false });
  expect(reportStillOpen.data.map((job) => job.id)).toEqual([report]);

  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/dismiss-failed`)).send({ queue: "missing" });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("QUEUE_NOT_FOUND");
  const invalid = await asAda(ada.post(`/api/v1/projects/${projectId}/jobs/dismiss-failed`)).send({ limit: 51 });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.dismissfailed@example.com",
    password,
  });
  const blocked = await request(server)
    .post(`/api/v1/projects/${projectId}/jobs/dismiss-failed`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(blocked.status).toBe(404);
});
