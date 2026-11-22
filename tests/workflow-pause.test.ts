import { createServer, type Server } from "node:http";
import { TaskFlow, TaskFlowError } from "@taskflow/sdk";
import { AuditLog } from "@taskflow/server";
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

it("pauses a workflow without cancelling a run that already started", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.pause@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Runs", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const queues = await asAda(ada.get(`/api/v1/projects/${projectId}/queues`));
  expect(queues.status).toBe(200);
  for (const queue of queues.body.data as { id: string; name: string }[]) {
    if (queue.name === "reports" || queue.name === "emails") {
      const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/queues/${queue.id}/pause`)).send({});
      expect(paused.status).toBe(200);
    }
  }

  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Report then email",
    steps,
  });
  expect(created.status).toBe(201);
  expect(created.body.data.paused).toBe(false);
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

  const early = await client.workflows.resume(workflowId).catch((error: unknown) => error);
  expect(early).toBeInstanceOf(TaskFlowError);
  expect((early as TaskFlowError).status).toBe(409);
  expect((early as TaskFlowError).code).toBe("WORKFLOW_NOT_PAUSED");

  const started = await client.workflows.start(workflowId);
  const paused = await client.workflows.pause(workflowId);
  expect(paused.data.id).toBe(workflowId);
  expect(paused.data.paused).toBe(true);
  expect(paused.data.name).toBe("Report then email");

  const kept = await client.workflows.run(workflowId, started.data.id);
  expect(kept.data.status).toBe("waiting");
  expect(kept.data.id).toBe(started.data.id);

  const blocked = await client.workflows.start(workflowId).catch((error: unknown) => error);
  expect(blocked).toBeInstanceOf(TaskFlowError);
  expect((blocked as TaskFlowError).status).toBe(409);
  expect((blocked as TaskFlowError).code).toBe("WORKFLOW_PAUSED");

  const again = await client.workflows.pause(workflowId).catch((error: unknown) => error);
  expect(again).toBeInstanceOf(TaskFlowError);
  expect((again as TaskFlowError).code).toBe("WORKFLOW_PAUSED");

  const audit = await AuditLog.findOne({ action: "workflow.paused", targetId: workflowId });
  expect(audit?.metadata).toMatchObject({ name: "Report then email" });

  const resumed = await client.workflows.resume(workflowId);
  expect(resumed.data.paused).toBe(false);
  const next = await client.workflows.start(workflowId);
  expect(next.data.id).not.toBe(started.data.id);
  expect(next.data.status).toBe("waiting");

  const loaded = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`));
  expect(loaded.status).toBe(200);
  expect(loaded.body.data.runCount).toBe(2);
  expect(loaded.body.data.steps).toHaveLength(2);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.pause@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/${workflowId}/pause`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
