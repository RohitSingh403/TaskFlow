import {
  AuditLog,
  CronError,
  PlanLimitError,
  QueueConfig,
  runScheduleNow,
  Schedule,
  createId,
  nextCronOccurrence,
  type ProjectDoc,
  type ScheduleDoc,
} from "@taskflow/server";
import {
  MAX_SCHEDULES_PER_PROJECT,
  findUnsafeKey,
  handlerSchemas,
  isHandlerName,
  MAX_PAYLOAD_BYTES,
  priorityToBull,
  simulationDecision,
  type HandlerName,
  type PriorityLabel,
} from "@taskflow/shared";
import { AppError } from "../../errors.js";
import { publish } from "../../infrastructure.js";
import { zodDetails } from "../../middleware/common.js";
import type { AuthContext } from "../../types.js";

export interface ScheduleInput {
  name: string;
  description?: string;
  queue: string;
  handler: string;
  payload: Record<string, unknown>;
  cron: string;
  timeZone?: string;
  priority?: PriorityLabel;
  maxAttempts?: number;
  backoffType?: "exponential" | "fixed";
  backoffDelayMs?: number;
  timeoutMs?: number;
}

function actor(auth: AuthContext) {
  return {
    type: auth.type,
    id: auth.type === "api_key" ? auth.apiKeyId ?? auth.userPublicId : auth.userPublicId,
    label: auth.label,
  };
}

function parseTiming(cron: string, timeZone: string, after = new Date()) {
  try {
    return nextCronOccurrence(cron, timeZone, after);
  } catch (error) {
    if (error instanceof CronError) throw new AppError(400, "INVALID_SCHEDULE", error.message);
    throw error;
  }
}

function parsePayload(project: ProjectDoc, handler: HandlerName, payload: Record<string, unknown>) {
  const unsafe = findUnsafeKey(payload);
  if (unsafe) throw new AppError(400, "VALIDATION_ERROR", `Unsafe payload key at ${unsafe}`);
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Job payload exceeds the 256 KB limit");
  }
  const parsed = handlerSchemas[handler].safeParse(payload);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Job payload is invalid", zodDetails(parsed.error));
  const simulation = simulationDecision(project.environment, parsed.data);
  if (!simulation.ok) throw new AppError(400, "SIMULATION_DISABLED", simulation.message);
  return parsed.data;
}

async function queueFor(project: ProjectDoc, name: string) {
  const queue = await QueueConfig.findOne({ projectId: project._id, name, deletedAt: null });
  if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  return queue;
}

export async function listSchedules(project: ProjectDoc) {
  return Schedule.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: -1 });
}

export async function getSchedule(project: ProjectDoc, scheduleId: string) {
  const schedule = await Schedule.findOne({ projectId: project._id, publicId: scheduleId, deletedAt: null });
  if (!schedule) throw new AppError(404, "SCHEDULE_NOT_FOUND", "Schedule not found");
  return schedule;
}

export async function createSchedule(project: ProjectDoc, input: ScheduleInput, auth: AuthContext) {
  if (!isHandlerName(input.handler)) throw new AppError(400, "HANDLER_NOT_FOUND", "Unknown job handler");
  const count = await Schedule.countDocuments({ projectId: project._id, deletedAt: null });
  if (count >= MAX_SCHEDULES_PER_PROJECT) {
    throw new AppError(409, "SCHEDULE_LIMIT", `A project can have ${MAX_SCHEDULES_PER_PROJECT} schedules`);
  }
  const queue = await queueFor(project, input.queue);
  const timeZone = input.timeZone || "UTC";
  const payload = parsePayload(project, input.handler, input.payload);
  const priority = input.priority ?? project.defaultJobSettings?.priority ?? "medium";
  try {
    const schedule = await Schedule.create({
      publicId: createId("sch"),
      projectId: project._id,
      projectPublicId: project.publicId,
      queueId: queue._id,
      queuePublicId: queue.publicId,
      queueName: queue.name,
      bullQueueName: queue.bullQueueName,
      name: input.name,
      description: input.description ?? "",
      handler: input.handler,
      payload,
      cron: input.cron,
      timeZone,
      priority,
      priorityValue: priorityToBull(priority),
      timeoutMs: input.timeoutMs ?? project.defaultJobSettings?.timeoutMs ?? 30_000,
      maxAttempts: input.maxAttempts ?? project.defaultJobSettings?.maxAttempts ?? 3,
      backoffType: input.backoffType ?? project.defaultJobSettings?.backoffType ?? "exponential",
      backoffDelayMs: input.backoffDelayMs ?? project.defaultJobSettings?.backoffDelayMs ?? 5_000,
      paused: false,
      nextRunAt: parseTiming(input.cron, timeZone),
      createdBy: actor(auth),
    });
    await AuditLog.create({
      projectId: project._id,
      actorType: auth.type,
      actorId: auth.userPublicId,
      action: "schedule.created",
      targetType: "schedule",
      targetId: schedule.publicId,
      metadata: { cron: schedule.cron, timeZone: schedule.timeZone },
    });
    return schedule;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && (error as { code?: number }).code === 11000) {
      throw new AppError(409, "SCHEDULE_EXISTS", "A schedule with that name already exists");
    }
    throw error;
  }
}

export async function updateSchedule(project: ProjectDoc, schedule: ScheduleDoc, input: Partial<ScheduleInput>, auth: AuthContext) {
  const handlerName = input.handler ?? schedule.handler;
  if (!isHandlerName(handlerName)) throw new AppError(400, "HANDLER_NOT_FOUND", "Unknown job handler");
  if (input.queue) {
    const queue = await queueFor(project, input.queue);
    schedule.queueId = queue._id;
    schedule.queuePublicId = queue.publicId;
    schedule.queueName = queue.name;
    schedule.bullQueueName = queue.bullQueueName;
  }
  if (input.payload || input.handler) {
    schedule.payload = parsePayload(project, handlerName, (input.payload ?? schedule.payload) as Record<string, unknown>);
    schedule.handler = handlerName;
  }
  if (input.name) schedule.name = input.name;
  if (input.description !== undefined) schedule.description = input.description;
  if (input.cron) schedule.cron = input.cron;
  if (input.timeZone) schedule.timeZone = input.timeZone;
  if (input.cron || input.timeZone) schedule.nextRunAt = parseTiming(schedule.cron, schedule.timeZone);
  if (input.priority) {
    schedule.priority = input.priority;
    schedule.priorityValue = priorityToBull(input.priority);
  }
  if (input.maxAttempts) schedule.maxAttempts = input.maxAttempts;
  if (input.backoffType) schedule.backoffType = input.backoffType;
  if (input.backoffDelayMs !== undefined) schedule.backoffDelayMs = input.backoffDelayMs;
  if (input.timeoutMs) schedule.timeoutMs = input.timeoutMs;
  await schedule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "schedule.updated",
    targetType: "schedule",
    targetId: schedule.publicId,
    metadata: {},
  });
  return schedule;
}

export async function setSchedulePaused(project: ProjectDoc, schedule: ScheduleDoc, paused: boolean, auth: AuthContext) {
  schedule.paused = paused;
  if (!paused && schedule.nextRunAt.getTime() <= Date.now()) {
    schedule.nextRunAt = parseTiming(schedule.cron, schedule.timeZone);
  }
  await schedule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: paused ? "schedule.paused" : "schedule.resumed",
    targetType: "schedule",
    targetId: schedule.publicId,
    metadata: {},
  });
  return schedule;
}

export async function triggerSchedule(project: ProjectDoc, schedule: ScheduleDoc, auth: AuthContext) {
  let job;
  try {
    job = await runScheduleNow(schedule);
  } catch (error) {
    if (error instanceof PlanLimitError) throw new AppError(402, "PLAN_LIMIT", error.message);
    if (error instanceof CronError) {
      const full = error.message.includes("waiting-job limit");
      throw new AppError(full ? 429 : 400, full ? "QUEUE_BACKPRESSURE" : "SCHEDULE_RUN_FAILED", error.message);
    }
    throw error;
  }
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "schedule.triggered",
    targetType: "schedule",
    targetId: schedule.publicId,
    metadata: { jobId: job.publicId },
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function deleteSchedule(project: ProjectDoc, schedule: ScheduleDoc, auth: AuthContext) {
  schedule.deletedAt = new Date();
  schedule.paused = true;
  await schedule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "schedule.deleted",
    targetType: "schedule",
    targetId: schedule.publicId,
    metadata: {},
  });
}
