import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { AuditLog, JobRecord, getBullQueue } from "@taskflow/server";
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

it("cancels waiting workflow steps and leaves a finished run alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.cancel@example.com",
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
  const runId = started.data.id;
  const cancelled = await client.workflows.cancel(workflowId, runId);
  expect(cancelled.data.status).toBe("cancelled");
  const steps = (cancelled.data as { steps: { key: string; status: string }[] }).steps;
  expect(steps.find((step) => step.key === "report")?.status).toBe("cancelled");
  expect(steps.find((step) => step.key === "email")?.status).toBe("cancelled");
  for (const step of steps) {
    const stored = await JobRecord.findOne({ publicId: (step as { jobId?: string }).jobId });
    expect(stored?.status).toBe("cancelled");
    expect(await getBullQueue(stored!.bullQueueName).getJob(stored!.publicId)).toBeUndefined();
  }
  const audit = await AuditLog.findOne({ action: "workflow.cancelled", targetId: runId });
  expect(audit?.metadata).toMatchObject({ workflowId, cancelled: 2 });

  const again = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${runId}/cancel`)).send({});
  expect(again.status).toBe(409);
  expect(again.body.error.code).toBe("WORKFLOW_RUN_NOT_CANCELLABLE");

  const blocked = await client.workflows.start(workflowId);
  const report = await JobRecord.findOne({ workflowRunId: blocked.data.id, workflowStepKey: "report" });
  if (!report) throw new Error("Report step was not recorded");
  report.status = "failed";
  report.error = { message: "Renderer unavailable" };
  report.completedAt = new Date();
  await report.save();
  const cleaned = await client.workflows.cancel(workflowId, blocked.data.id);
  expect(cleaned.data.status).toBe("cancelled");
  const cleanedSteps = (cleaned.data as { steps: { key: string; status: string }[] }).steps;
  expect(cleanedSteps.find((step) => step.key === "report")?.status).toBe("failed");
  expect(cleanedSteps.find((step) => step.key === "email")?.status).toBe("cancelled");

  const finished = await client.workflows.start(workflowId);
  await JobRecord.updateMany({ workflowRunId: finished.data.id }, { status: "completed", completedAt: new Date() });
  const done = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${finished.data.id}/cancel`)).send({});
  expect(done.status).toBe(409);
  expect(done.body.error.code).toBe("WORKFLOW_RUN_NOT_CANCELLABLE");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.cancel@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/${workflowId}/runs/${runId}/cancel`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
