import { createServer, type Server } from "node:http";
import { Schedule } from "@taskflow/server";
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

it("sets the time zone on the oldest schedules, including a paused one, and leaves a matching or deleted schedule alone", async () => {
  const ada = request.agent(server);
  const registered = await ada.post("/api/v1/auth/register").send({
    name: "Ada Lovelace",
    email: "ada.set-timezone@example.com",
    password,
  });
  expect(registered.status).toBe(201);
  const token = registered.body.data.accessToken as string;
  const asAda = (call: request.Test) => call.set("Authorization", `Bearer ${token}`);

  const project = await asAda(ada.post("/api/v1/projects")).send({ name: "Reports", environment: "development" });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;

  async function create(name: string, timeZone: string) {
    const created = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules`)).send({
      name,
      queue: "reports",
      handler: "generate-report",
      cron: "0 9 * * *",
      timeZone,
      payload,
    });
    expect(created.status).toBe(201);
    return created.body.data as { id: string; nextRunAt: string; paused: boolean; timeZone: string; cron: string; name: string };
  }

  const oldest = await create("Morning report", "UTC");
  const later = await create("Evening report", "UTC");
  const matching = await create("Kolkata report", "Asia/Kolkata");
  const removed = await create("Retired report", "UTC");
  const pausedOne = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/${oldest.id}/pause`));
  expect(pausedOne.status).toBe(200);
  const deleted = await asAda(ada.delete(`/api/v1/projects/${projectId}/schedules/${removed.id}`));
  expect(deleted.status).toBe(200);

  const tooSmall = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/timezone`)).send({ timeZone: "Asia/Kolkata", limit: 0 });
  expect(tooSmall.status).toBe(400);
  expect(tooSmall.body.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/timezone`)).send({ timeZone: "Asia/Kolkata", limit: 51 });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
  const blank = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/timezone`)).send({ timeZone: "   ", limit: 1 });
  expect(blank.status).toBe(400);
  expect(blank.body.error.code).toBe("VALIDATION_ERROR");
  const tooLong = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/timezone`)).send({ timeZone: "A".repeat(81), limit: 1 });
  expect(tooLong.status).toBe(400);
  expect(tooLong.body.error.code).toBe("VALIDATION_ERROR");
  const unknown = await asAda(ada.post(`/api/v1/projects/${projectId}/schedules/timezone`)).send({ timeZone: "Not/AZone", limit: 20 });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.code).toBe("INVALID_SCHEDULE");
  const untouched = await Schedule.findOne({ publicId: oldest.id });
  expect(untouched?.timeZone).toBe("UTC");
  expect(untouched?.nextRunAt.toISOString()).toBe(oldest.nextRunAt);

  const reader = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "reader", scopes: ["jobs:read"] });
  const writer = await asAda(ada.post(`/api/v1/projects/${projectId}/api-keys`)).send({ name: "writer", scopes: ["jobs:read", "jobs:write"] });
  expect(reader.status).toBe(201);
  expect(writer.status).toBe(201);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const reading = new TaskFlow({ apiKey: reader.body.data.secret, baseUrl, projectId });
  await expect(reading.schedules.setTimeZone({ timeZone: "Asia/Kolkata", limit: 1 })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

  const writing = new TaskFlow({ apiKey: writer.body.data.secret, baseUrl, projectId });
  const first = await writing.schedules.setTimeZone({ timeZone: "Asia/Kolkata", limit: 1 });
  expect(first.data).toEqual({ updated: 1, skipped: 0, scheduleIds: [oldest.id] });
  const storedOldest = await Schedule.findOne({ publicId: oldest.id });
  expect(storedOldest?.timeZone).toBe("Asia/Kolkata");
  expect(storedOldest?.paused).toBe(true);
  expect(storedOldest?.cron).toBe("0 9 * * *");
  expect(storedOldest?.name).toBe("Morning report");
  expect(storedOldest?.queueName).toBe("reports");
  expect(storedOldest?.handler).toBe("generate-report");
  expect(storedOldest?.payload).toMatchObject(payload);
  expect(storedOldest?.deletedAt).toBeUndefined();
  expect(storedOldest?.nextRunAt.toISOString()).not.toBe(oldest.nextRunAt);
  const storedLater = await Schedule.findOne({ publicId: later.id });
  expect(storedLater?.timeZone).toBe("UTC");

  const second = await writing.schedules.setTimeZone({ timeZone: "Asia/Kolkata", limit: 20 });
  expect(second.data).toEqual({ updated: 1, skipped: 2, scheduleIds: [later.id] });
  const storedLaterAfter = await Schedule.findOne({ publicId: later.id });
  expect(storedLaterAfter?.timeZone).toBe("Asia/Kolkata");
  expect(storedLaterAfter?.paused).toBe(false);
  expect(storedLaterAfter?.cron).toBe(later.cron);
  expect(storedLaterAfter?.name).toBe(later.name);
  expect(storedLaterAfter?.nextRunAt.toISOString()).not.toBe(later.nextRunAt);
  const storedMatching = await Schedule.findOne({ publicId: matching.id });
  expect(storedMatching?.timeZone).toBe("Asia/Kolkata");
  expect(storedMatching?.nextRunAt.toISOString()).toBe(matching.nextRunAt);
  expect(storedMatching?.name).toBe("Kolkata report");
  const storedGone = await Schedule.findOne({ publicId: removed.id });
  expect(storedGone?.deletedAt).toBeInstanceOf(Date);
  expect(storedGone?.timeZone).toBe("UTC");
  expect(storedGone?.name).toBe("Retired report");

  const again = await writing.schedules.setTimeZone({ timeZone: "Asia/Kolkata", limit: 20 });
  expect(again.data).toEqual({ updated: 0, skipped: 3, scheduleIds: [] });

  const outsider = await request(server).post("/api/v1/auth/register").send({
    name: "Katherine Johnson",
    email: "katherine.set-timezone@example.com",
    password,
  });
  const hidden = await request(server)
    .post(`/api/v1/projects/${projectId}/schedules/timezone`)
    .set("Authorization", `Bearer ${outsider.body.data.accessToken}`)
    .send({ timeZone: "Asia/Kolkata", limit: 1 });
  expect(hidden.status).toBe(404);
});
