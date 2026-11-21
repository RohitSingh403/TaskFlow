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

it("queues one job from a paused schedule and leaves the next cron time unchanged", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.run@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Run now", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
    name: "Morning report",
    queue: "reports",
    handler: "generate-report",
    cron: "0 9 * * *",
    timeZone: "UTC",
    payload: { reportType: "sales", format: "pdf", rangeDays: 7 },
  });
  expect(created.status).toBe(201);
  const scheduleId = created.body.data.id as string;
  const nextRunAt = created.body.data.nextRunAt as string;

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  expect(reader.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.schedules.run(scheduleId)).rejects.toMatchObject({ status: 403 });

  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/${scheduleId}/pause`));
  expect(paused.status).toBe(200);
  expect(paused.body.data.paused).toBe(true);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({
    name: "writer",
    scopes: ["jobs:read", "jobs:write"],
  });
  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.schedules.run(scheduleId);
  const second = await writing.schedules.run(scheduleId);
  expect(first.data.id.startsWith("job_")).toBe(true);
  expect(second.data.id.startsWith("job_")).toBe(true);
  expect(second.data.id).not.toBe(first.data.id);
  expect(first.data.status).toMatch(/waiting|delayed|active/);

  const schedule = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules/${scheduleId}`));
  expect(schedule.status).toBe(200);
  expect(schedule.body.data.nextRunAt).toBe(nextRunAt);
  expect(schedule.body.data.paused).toBe(true);
  expect(schedule.body.data.lastJobId).toBe(second.data.id);

  const job = await asAda(ada.get(`/api/v1/projects/${projectId}/jobs/${first.data.id}`));
  expect(job.body.data.scheduleId).toBe(scheduleId);
  expect(job.body.data.name).toBe("generate-report");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.run@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/${scheduleId}/run`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);
});
