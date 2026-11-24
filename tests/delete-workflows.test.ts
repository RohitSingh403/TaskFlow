import { createServer, type Server } from "node:http";
import { TaskFlow } from "@taskflow/sdk";
import { Workflow } from "@taskflow/server";
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

it("deletes the oldest workflows, including a paused one, and leaves an already deleted workflow alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.delete-workflows@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Flows", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows`)).send({
      name,
      description: "Report then email",
      steps,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; name: string; paused: boolean };
  }

  const oldest = await create("Morning flow");
  const later = await create("Evening flow");
  const held = await create("Held flow");
  const removed = await create("Removed flow");
  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/${held.id}/pause`));
  expect(paused.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/workflows/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/delete`)).send({ limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/workflows/delete`)).send({ limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:read", "jobs:write"],
  });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.workflows.deleteWorkflows({ limit: 1 })).rejects.toMatchObject({ status: 403 });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.workflows.deleteWorkflows({ limit: 1 });
  expect(first.data).toEqual({ deleted: 1, skipped: 0, workflowIds: [oldest.id] });
  const storedOldest = await Workflow.findOne({ publicId: oldest.id });
  expect(storedOldest?.deletedAt).toBeInstanceOf(Date);
  expect(storedOldest?.name).toBe("Morning flow");
  expect(storedOldest?.paused).toBe(false);
  expect(storedOldest?.steps).toHaveLength(2);
  await expect(writing.workflows.get(oldest.id)).rejects.toMatchObject({ status: 404 });
  const listed = await writing.workflows.list();
  expect(listed.data.map((workflow) => workflow.id).sort()).toEqual([held.id, later.id].sort());
  expect(listed.data.find((workflow) => workflow.id === held.id)?.paused).toBe(true);

  const second = await writing.workflows.deleteWorkflows({ limit: 20 });
  expect(second.data).toEqual({ deleted: 2, skipped: 0, workflowIds: [later.id, held.id] });
  const storedHeld = await Workflow.findOne({ publicId: held.id });
  expect(storedHeld?.deletedAt).toBeInstanceOf(Date);
  expect(storedHeld?.paused).toBe(true);
  expect(storedHeld?.name).toBe("Held flow");
  expect(storedHeld?.steps).toHaveLength(2);
  expect((await writing.workflows.list()).data).toEqual([]);

  const again = await writing.workflows.deleteWorkflows({ limit: 20 });
  expect(again.data).toEqual({ deleted: 0, skipped: 0, workflowIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.delete-workflows@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/workflows/delete`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ limit: 1 });
  expect(hidden.status).toBe(404);
});
