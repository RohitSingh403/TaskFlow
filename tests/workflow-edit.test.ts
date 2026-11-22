import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
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

it("renames a workflow without replacing its steps or runs", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.workflow@example.com",
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
    description: "Generate the activity report, then send it.",
    steps,
  });
  expect(created.status).toBe(201);
  const workflowId = created.body.data.id as string;
  const other = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
    name: "Digest",
    steps,
  });
  expect(other.status).toBe(201);

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
  const renamed = await client.workflows.update(workflowId, {
    name: "Weekly digest",
    description: "Send the weekly activity report.",
  });
  expect(renamed.data.id).toBe(workflowId);
  expect(renamed.data.name).toBe("Weekly digest");
  expect(renamed.data.description).toBe("Send the weekly activity report.");

  const loaded = await asAda(ada.get(`/api/v1/projects/${projectId}/workflows/${workflowId}`));
  expect(loaded.status).toBe(200);
  expect(loaded.body.data.runCount).toBe(1);
  expect(loaded.body.data.lastRun.id).toBe(started.data.id);
  expect(loaded.body.data.steps).toEqual([
    expect.objectContaining({ key: "report", handler: "generate-report", queue: "reports" }),
    expect.objectContaining({ key: "email", handler: "send-email", queue: "emails", dependsOn: ["report"] }),
  ]);

  const audit = await AuditLog.findOne({ action: "workflow.updated", targetId: workflowId });
  expect(audit?.metadata).toMatchObject({
    name: "Weekly digest",
    previousName: "Report then email",
    description: "Send the weekly activity report.",
    previousDescription: "Generate the activity report, then send it.",
  });

  const duplicate = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({ name: "Digest" });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("WORKFLOW_EXISTS");

  const short = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({ name: "a" });
  expect(short.status).toBe(400);
  expect(short.body.error.code).toBe("VALIDATION_ERROR");

  const empty = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({});
  expect(empty.status).toBe(400);
  expect(empty.body.error.code).toBe("VALIDATION_ERROR");

  const ignored = await asAda(ada.patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)).send({
    description: "Still the same steps.",
    steps: [],
  });
  expect(ignored.status).toBe(200);
  expect(ignored.body.data.steps).toHaveLength(2);

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.workflow@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}/workflows/${workflowId}`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ name: "Hidden" });
  expect(hidden.status).toBe(404);
});
