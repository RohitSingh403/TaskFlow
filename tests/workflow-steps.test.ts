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
const steps = [
  {
    key: "report",
    handler: "generate-report",
    queue: "reports",
    dependsOn: [],
    payload: { reportType: "activity", format: "pdf", rangeDays: 7 },
  },
  {
    key: "email",
    handler: "send-email",
    queue: "emails",
    dependsOn: ["report"],
    payload: { to: "ops@example.com", subject: "Activity report", body: "The activity report is ready." },
  },
];
const replacement = [
  ...steps,
  {
    key: "notice",
    handler: "send-notification",
    queue: "notifications",
    dependsOn: ["email"],
    payload: { channel: "in-app", recipientId: "ops", message: "The report was sent." },
  },
];

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

it("replaces workflow steps and leaves the run that already started", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.steps@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Runs", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  for (const queue of queues.body.data as { id: string; name: string }[]) {
    if (queue.name === "reports" || queue.name === "emails" || queue.name === "notifications") {
      const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${queue.id}/pause`)).send({});
      expect(paused.status).toBe(200);
    }
  }

  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Report then email",
    description: "Generate the activity report, then send it.",
    steps,
  });
  expect(created.status).toBe(201);
  const workflowId = created.body.data.id as string;

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

  const started = await client.workflows.start(workflowId);
  const before = await client.workflows.run(workflowId, started.data.id);
  const oldJobIds = (before.data as { steps: { key: string; jobId: string }[] }).steps.map((step) => step.jobId);

  const updated = await client.workflows.update(workflowId, { steps: replacement });
  expect(updated.data.id).toBe(workflowId);
  expect(updated.data.name).toBe("Report then email");
  expect(updated.data.paused).toBe(false);

  const loaded = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`));
  expect(loaded.status).toBe(200);
  expect(loaded.body.data.steps.map((step: { key: string }) => step.key)).toEqual(["report", "email", "notice"]);
  expect(loaded.body.data.executionOrder).toEqual(["report", "email", "notice"]);
  expect(loaded.body.data.runCount).toBe(1);
  expect(loaded.body.data.lastRun.id).toBe(started.data.id);
  expect(loaded.body.data.lastRun.steps.map((step: { key: string; jobId: string }) => step.jobId)).toEqual(oldJobIds);
  expect(loaded.body.data.lastRun.steps.map((step: { key: string }) => step.key)).toEqual(["report", "email"]);

  const again = await client.workflows.start(workflowId);
  const next = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${again.data.id}`));
  expect(next.status).toBe(200);
  expect(next.body.data.steps.map((step: { key: string }) => step.key)).toEqual(["report", "email", "notice"]);
  expect(next.body.data.id).not.toBe(started.data.id);

  const fork = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({
    steps: [
      { ...steps[0] },
      { ...steps[1], dependsOn: ["report"] },
      { ...replacement[2], dependsOn: ["report"] },
    ],
  });
  expect(fork.status).toBe(400);
  expect(fork.body.error.code).toBe("VALIDATION_ERROR");
  const unknown = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({
    steps: [{ ...steps[0], queue: "missing" }, steps[1]],
  });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("QUEUE_NOT_FOUND");

  const still = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`));
  expect(still.body.data.steps.map((step: { key: string }) => step.key)).toEqual(["report", "email", "notice"]);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.steps@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ steps: replacement });
  expect(hidden.status).toBe(404);
});
