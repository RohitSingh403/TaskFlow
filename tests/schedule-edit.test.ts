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
const payload = { reportType: "sales", format: "pdf", rangeDays: 7 };

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

it("keeps the schedule id when the cron changes and leaves a pause in place", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.schedule@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Reports", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const created = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
    name: "Morning report",
    queue: "reports",
    handler: "generate-report",
    cron: "0 9 * * *",
    timeZone: "UTC",
    payload,
  });
  expect(created.status).toBe(201);
  const scheduleId = created.body.data.id as string;
  const paused = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/${scheduleId}/pause`));
  expect(paused.status).toBe(200);

  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:write", "jobs:read"] });
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const client = new TaskFlow({
    apiKey: writer.body.data.secret,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    projectId,
  });
  const updated = await client.schedules.update(scheduleId, { cron: "0 18 * * *" });
  expect(updated.data.id).toBe(scheduleId);
  expect(updated.data.cron).toBe("0 18 * * *");
  expect(updated.data.paused).toBe(true);
  expect(updated.data.nextRunAt).not.toBe(created.body.data.nextRunAt);
  expect(updated.data.queue).toBe("reports");

  const invalid = await asAda(ada.patch(`/api/v1/projects/${projectId}/schedules/${scheduleId}`)).send({ cron: "every morning" });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("INVALID_SCHEDULE");

  const empty = await asAda(ada.patch(`/api/v1/projects/${projectId}/schedules/${scheduleId}`)).send({});
  expect(empty.status).toBe(400);
  expect(empty.body.error.code).toBe("VALIDATION_ERROR");

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.schedule@example.com",
    password,
  });
  const hidden = await request(server)
    .patch(`/api/v1/projects/${projectId}/schedules/${scheduleId}`)
    .send({ cron: "0 8 * * *" })
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`);
  expect(hidden.status).toBe(404);

  const listed = await asAda(ada.get(`/api/v1/projects/${projectId}/schedules`));
  expect(listed.body.data).toHaveLength(1);
  expect(listed.body.data[0].cron).toBe("0 18 * * *");
});
