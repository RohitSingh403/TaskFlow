import { createServer, type Server } from "node:http";
import { JobRecord, WorkflowRun, getBullQueue } from "@taskflow/server";
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

it("cancels the oldest waiting workflow runs and keeps each id", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.cancel-runs@example.com",
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

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
      name,
      steps: [
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
      ],
    });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  async function start(workflowId: string) {
    const started = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs`)).send({});
    expect(started.status).toBe(201);
    return started.body.data as { id: string; status: string; steps: { key: string; status: string; jobId: string }[] };
  }

  const workflowId = await create("Oldest report");
  const oldest = await start(workflowId);
  const later = await start(workflowId);
  const heldWorkflowId = await create("Held report");
  const held = await start(heldWorkflowId);
  const heldCancel = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${heldWorkflowId}/runs/${held.id}/cancel`)).send({});
  expect(heldCancel.status).toBe(200);
  const removedWorkflowId = await create("Removed report");
  const removed = await start(removedWorkflowId);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/workflows/${removedWorkflowId}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/runs/cancel`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/runs/cancel`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/runs/cancel`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ cancelled: 1, skipped: 0, runIds: [oldest.id] });
  const oldestAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${oldest.id}`));
  expect(oldestAfter.status).toBe(200);
  expect(oldestAfter.body.data.id).toBe(oldest.id);
  expect(oldestAfter.body.data.status).toBe("cancelled");
  expect(oldestAfter.body.data.steps.find((step: { key: string }) => step.key === "report")?.status).toBe("cancelled");
  expect(oldestAfter.body.data.steps.find((step: { key: string }) => step.key === "email")?.status).toBe("cancelled");
  const report = oldest.steps.find((step) => step.key === "report");
  const stored = await JobRecord.findOne({ publicId: report?.jobId });
  expect(stored?.status).toBe("cancelled");
  expect(await getBullQueue(stored!.bullQueueName).getJob(stored!.publicId)).toBeUndefined();
  const laterStill = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${later.id}`));
  expect(laterStill.body.data.status).toBe("waiting");
  const heldStill = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${heldWorkflowId}/runs/${held.id}`));
  expect(heldStill.body.data.status).toBe("cancelled");
  const removedStill = await WorkflowRun.findOne({ publicId: removed.id });
  expect(removedStill?.status).toBe("waiting");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/runs/cancel`)
    .set("Authorization", `Bearer ${reader.body.data.secret}`)
    .send({ limit: 20 });
  expect(denied.status).toBe(403);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write", "jobs:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const second = await client.workflows.cancelRuns({ limit: 20 });
  expect(second.data).toEqual({ cancelled: 1, skipped: 0, runIds: [later.id] });
  const laterAfter = await client.workflows.run(workflowId, later.id);
  expect(laterAfter.data.id).toBe(later.id);
  expect(laterAfter.data.status).toBe("cancelled");
  const removedAfter = await WorkflowRun.findOne({ publicId: removed.id });
  expect(removedAfter?.status).toBe("waiting");

  const again = await client.workflows.cancelRuns({ limit: 20 });
  expect(again.data).toEqual({ cancelled: 0, skipped: 0, runIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.cancel-runs@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/runs/cancel`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
