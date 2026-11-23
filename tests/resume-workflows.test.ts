import { createServer, type Server } from "node:http";
import { Workflow } from "@taskflow/server";
import { TaskFlow, TaskFlowError } from "@taskflow/sdk";
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

it("resumes the oldest paused workflows and leaves a run that already started", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.resume-workflows@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Runs", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({ name, steps });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; paused: boolean; name: string };
  }

  const oldest = await create("Morning report");
  const later = await create("Evening report");
  const running = await create("Hourly report");
  const removed = await create("Retired report");
  const started = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${oldest.id}/runs`)).send({});
  expect(started.status).toBe(201);
  const runId = started.body.data.id as string;
  for (const workflow of [oldest, later, removed]) {
    const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${workflow.id}/pause`));
    expect(paused.status).toBe(200);
  }
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/workflows/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/resume`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/resume`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const first = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/resume`)).send({ limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ resumed: 1, skipped: 0, workflowIds: [oldest.id] });
  const oldestAfter = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${oldest.id}`));
  expect(oldestAfter.status).toBe(200);
  expect(oldestAfter.body.data.paused).toBe(false);
  expect(oldestAfter.body.data.name).toBe("Morning report");
  expect(oldestAfter.body.data.steps).toHaveLength(2);
  const kept = oldestAfter.body.data.runs.find((run: { id: string }) => run.id === runId);
  expect(kept.status).toBe("waiting");
  const againRun = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${oldest.id}/runs`)).send({});
  expect(againRun.status).toBe(201);
  const laterStill = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${later.id}`));
  expect(laterStill.body.data.paused).toBe(true);
  const runningStill = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${running.id}`));
  expect(runningStill.body.data.paused).toBe(false);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const denied = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/resume`)
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
  const second = await client.workflows.resumeWorkflows({ limit: 20 });
  expect(second.data).toEqual({ resumed: 1, skipped: 0, workflowIds: [later.id] });
  const laterAfter = await client.workflows.get(later.id);
  expect(laterAfter.data.paused).toBe(false);
  expect(laterAfter.data.id).toBe(later.id);
  const removedAfter = await Workflow.findOne({ publicId: removed.id });
  expect(removedAfter?.deletedAt).toBeTruthy();
  expect(removedAfter?.paused).toBe(true);

  const again = await client.workflows.resumeWorkflows({ limit: 20 });
  expect(again.data).toEqual({ resumed: 0, skipped: 0, workflowIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.resume-workflows@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/resume`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);

  const single = await client.workflows.resume(later.id).catch((error: unknown) => error);
  expect(single).toBeInstanceOf(TaskFlowError);
  expect((single as TaskFlowError).code).toBe("WORKFLOW_NOT_PAUSED");
});
