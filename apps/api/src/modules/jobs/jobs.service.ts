import {
  AuditLog,
  PlanLimitError,
  assertJobAllowance,
  createId,
  dispatchWebhooks,
  enqueueJob,
  getBullQueue,
  hashRequest,
  isDuplicateKeyError,
  JobAttempt,
  JobRecord,
  QueueConfig,
  syncWorkflowRun,
  type JobDoc,
  type ProjectDoc,
  type QueueDoc,
} from "@taskflow/server";
import {
  DEFAULT_MAX_WAITING,
  findUnsafeKey,
  handlerSchemas,
  isHandlerName,
  CANCEL_QUEUED_LIMIT,
  DEAD_LETTER_RETRY_LIMIT,
  MAX_PAYLOAD_BYTES,
  priorityToBull,
  simulationDecision,
  type HandlerName,
  type PriorityLabel,
} from "@taskflow/shared";
import type { JobsOptions } from "bullmq";
import { AppError } from "../../errors.js";
import { zodDetails } from "../../middleware/common.js";
import { publish } from "../../infrastructure.js";
import type { AuthContext } from "../../types.js";

export interface SubmitJobInput {
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  priority?: PriorityLabel;
  delayMs?: number;
  maxAttempts?: number;
  backoffType?: "exponential" | "fixed";
  backoffDelayMs?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

function actor(auth: AuthContext) {
  return {
    type: auth.type,
    id: auth.type === "api_key" ? auth.apiKeyId ?? auth.userPublicId : auth.userPublicId,
    label: auth.label,
  };
}

function executionData(job: JobDoc) {
  return {
    publicId: job.publicId,
    projectObjectId: String(job.projectId),
    projectPublicId: job.projectPublicId,
    queueName: job.queueName,
    handler: job.name,
    payload: job.payload,
    timeoutMs: job.timeoutMs,
    traceId: job.traceId,
    allowSimulation: job.allowSimulation,
  };
}

function executionOptions(job: JobDoc): JobsOptions {
  return {
    attempts: job.maxAttempts,
    backoff: { type: job.backoffType, delay: job.backoffDelayMs },
    delay: job.delayMs > 0 ? job.delayMs : undefined,
    priority: job.priorityValue,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
  };
}

async function placeOnQueue(job: JobDoc) {
  await enqueueJob({
    queueName: job.bullQueueName,
    jobName: job.name,
    jobId: job.publicId,
    data: executionData(job),
    options: executionOptions(job),
  });
  job.enqueued = true;
  await job.save();
}

export async function submitJob(project: ProjectDoc, input: SubmitJobInput, auth: AuthContext) {
  if (!isHandlerName(input.name)) throw new AppError(400, "HANDLER_NOT_FOUND", "Unknown job handler");
  const handler = input.name as HandlerName;
  const unsafe = findUnsafeKey(input.payload);
  if (unsafe) throw new AppError(400, "VALIDATION_ERROR", `Unsafe payload key at ${unsafe}`);
  const payloadSize = Buffer.byteLength(JSON.stringify(input.payload));
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Job payload exceeds the 256 KB limit");
  }
  const parsed = handlerSchemas[handler].safeParse(input.payload);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Job payload is invalid", zodDetails(parsed.error));
  }
  const simulation = simulationDecision(project.environment, parsed.data);
  if (!simulation.ok) throw new AppError(400, "SIMULATION_DISABLED", simulation.message);

  const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
  if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");

  const settings = {
    priority: input.priority ?? project.defaultJobSettings?.priority ?? "medium",
    maxAttempts: input.maxAttempts ?? project.defaultJobSettings?.maxAttempts ?? 3,
    backoffType: input.backoffType ?? project.defaultJobSettings?.backoffType ?? "exponential",
    backoffDelayMs: input.backoffDelayMs ?? project.defaultJobSettings?.backoffDelayMs ?? 5_000,
    timeoutMs: input.timeoutMs ?? project.defaultJobSettings?.timeoutMs ?? 30_000,
    delayMs: input.delayMs ?? 0,
  } as const;

  const requestHash = hashRequest({
    queue: input.queue,
    name: handler,
    payload: parsed.data,
    ...settings,
    metadata: input.metadata ?? {},
  });

  if (input.idempotencyKey) {
    const existing = await JobRecord.findOne({ projectId: project._id, idempotencyKey: input.idempotencyKey });
    if (existing) return replayOrConflict(existing, requestHash);
  }

  try {
    await assertJobAllowance(project, 1);
  } catch (error) {
    if (error instanceof PlanLimitError) throw new AppError(402, "PLAN_LIMIT", error.message);
    throw error;
  }
  await assertCapacity(queue);

  const publicId = createId("job");
  let job: JobDoc;
  try {
    job = await JobRecord.create({
      publicId,
      projectId: project._id,
      projectPublicId: project.publicId,
      queueId: queue._id,
      queuePublicId: queue.publicId,
      queueName: queue.name,
      bullQueueName: queue.bullQueueName,
      name: handler,
      payload: parsed.data,
      metadata: input.metadata ?? {},
      status: settings.delayMs > 0 ? "delayed" : "waiting",
      priority: settings.priority,
      priorityValue: priorityToBull(settings.priority),
      delayMs: settings.delayMs,
      timeoutMs: settings.timeoutMs,
      maxAttempts: settings.maxAttempts,
      backoffType: settings.backoffType,
      backoffDelayMs: settings.backoffDelayMs,
      allowSimulation: project.environment === "development",
      traceId: createId("trace"),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      enqueued: false,
      createdBy: actor(auth),
    });
  } catch (error) {
    if (input.idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await JobRecord.findOne({ projectId: project._id, idempotencyKey: input.idempotencyKey });
      if (existing) return replayOrConflict(existing, requestHash);
    }
    throw error;
  }

  try {
    await placeOnQueue(job);
  } catch (error) {
    const existing = await getBullQueue(job.bullQueueName).getJob(job.publicId).catch(() => null);
    if (existing) {
      job.enqueued = true;
      await job.save();
    } else {
      job.status = "failed";
      job.enqueued = false;
      job.completedAt = new Date();
      job.error = { message: "The job record was saved, but Redis did not accept it.", code: "ENQUEUE_FAILED" };
      await job.save();
      throw new AppError(503, "ENQUEUE_FAILED", "The job was recorded but could not be placed on the queue");
    }
  }

  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return { job, duplicate: false };
}

function replayOrConflict(existing: JobDoc, requestHash: string) {
  if (existing.requestHash !== requestHash) {
    throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used with a different request");
  }
  return { job: existing, duplicate: true };
}

async function assertCapacity(queue: QueueDoc) {
  const counts = await getBullQueue(queue.bullQueueName).getJobCounts("waiting", "delayed", "prioritized", "paused");
  const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0);
  const limit = queue.maxWaiting || DEFAULT_MAX_WAITING;
  if (backlog >= limit) {
    throw new AppError(429, "QUEUE_BACKPRESSURE", "This queue is at its waiting-job limit. Retry after workers drain it.");
  }
}

export interface JobListQuery {
  status?: string;
  queue?: string;
  priority?: string;
  name?: string;
  jobId?: string;
  idempotencyKey?: string;
  schedule?: string;
  dismissed?: "true" | "false";
  q?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export async function listJobs(project: ProjectDoc, query: JobListQuery) {
  const filter: Record<string, unknown> = { projectId: project._id };
  if (query.status) filter.status = query.status;
  if (query.queue) filter.queueName = query.queue;
  if (query.priority) filter.priority = query.priority;
  if (query.name) filter.name = query.name;
  if (query.jobId) filter.publicId = query.jobId;
  if (query.idempotencyKey) filter.idempotencyKey = query.idempotencyKey;
  if (query.schedule) filter.scheduleId = query.schedule;
  if (query.dismissed === "true") filter.dismissedAt = { $ne: null };
  if (query.dismissed === "false") filter.dismissedAt = null;
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lte: new Date(query.to) } : {}),
    };
  }
  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ publicId: query.q }, { name: new RegExp(escaped, "i") }, { queueName: new RegExp(escaped, "i") }];
  }
  const skip = (query.page - 1) * query.limit;
  const [jobs, total] = await Promise.all([
    JobRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    JobRecord.countDocuments(filter),
  ]);
  return { jobs, total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) };
}

export async function getJob(project: ProjectDoc, jobId: string) {
  const job = await JobRecord.findOne({ projectId: project._id, publicId: jobId });
  if (!job) throw new AppError(404, "JOB_NOT_FOUND", "The requested job was not found");
  return job;
}

export async function listAttempts(project: ProjectDoc, jobId: string) {
  const job = await getJob(project, jobId);
  const attempts = await JobAttempt.find({ jobId: job._id }).sort({ attemptNumber: 1 }).lean();
  return attempts.map((attempt) => ({
    attemptNumber: attempt.attemptNumber,
    workerId: attempt.workerId ?? null,
    status: attempt.status,
    startedAt: attempt.startedAt?.toISOString?.() ?? null,
    finishedAt: attempt.finishedAt?.toISOString?.() ?? null,
    durationMs: attempt.durationMs ?? null,
    errorMessage: attempt.errorMessage ?? null,
    errorStack: attempt.errorStack ?? null,
  }));
}

export async function retryJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (job.status !== "failed") throw new AppError(409, "JOB_NOT_RETRYABLE", "Only failed jobs can be retried");
  const queue = getBullQueue(job.bullQueueName);
  const bullJob = await queue.getJob(job.publicId);
  if (!bullJob) {
    await placeOnQueue(job);
  } else {
    const state = await bullJob.getState();
    if (state === "failed") await bullJob.retry();
    else if (state === "completed") throw new AppError(409, "JOB_NOT_RETRYABLE", "The queue already marked this job completed");
  }
  job.status = job.delayMs > 0 ? "delayed" : "waiting";
  job.set("error", undefined);
  job.set("result", undefined);
  job.completedAt = undefined;
  job.set("dismissedAt", undefined);
  job.enqueued = true;
  await job.save();
  await syncWorkflowRun(job.workflowRunId);
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.retried",
    targetType: "job",
    targetId: job.publicId,
    metadata: {},
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function replayJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const source = await getJob(project, jobId);
  const payload = JSON.parse(JSON.stringify(source.payload)) as Record<string, unknown>;
  const stored = JSON.parse(JSON.stringify(source.metadata ?? {})) as Record<string, string | number | boolean | null>;
  const result = await submitJob(
    project,
    {
      queue: source.queueName,
      name: source.name,
      payload,
      priority: source.priority,
      maxAttempts: source.maxAttempts,
      backoffType: source.backoffType,
      backoffDelayMs: source.backoffDelayMs,
      timeoutMs: source.timeoutMs,
      delayMs: 0,
      metadata: { ...stored, replayedFrom: source.publicId },
    },
    auth,
  );
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.replayed",
    targetType: "job",
    targetId: result.job.publicId,
    metadata: { sourceJobId: source.publicId },
  });
  return result.job;
}

export async function promoteJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (job.status !== "delayed") throw new AppError(409, "JOB_NOT_DELAYED", "Only a delayed job can run now");
  const previousDelayMs = job.delayMs;
  const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "delayed") await bullJob.promote();
    else if (!["waiting", "prioritized", "paused"].includes(state)) {
      throw new AppError(409, "JOB_NOT_DELAYED", "Only a delayed job can run now");
    }
  }
  job.delayMs = 0;
  job.status = "waiting";
  if (bullJob) await job.save();
  else await placeOnQueue(job);
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.promoted",
    targetType: "job",
    targetId: job.publicId,
    metadata: { delayMs: previousDelayMs },
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function rescheduleJob(project: ProjectDoc, jobId: string, input: { delayMs: number }, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (!["waiting", "delayed"].includes(job.status)) {
    throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can be rescheduled");
  }
  const previousDelayMs = job.delayMs;
  const nextStatus = input.delayMs > 0 ? "delayed" : "waiting";
  const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
  let replaced = false;
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "active") throw new AppError(409, "JOB_NOT_QUEUED", "An active job cannot be rescheduled");
    if (!["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can be rescheduled");
    }
    if (state === "delayed" && input.delayMs > 0) {
      await bullJob.changeDelay(input.delayMs);
    } else if (state === "delayed" && input.delayMs === 0) {
      await bullJob.promote();
    } else if (input.delayMs > 0) {
      if (job.workflowRunId) {
        throw new AppError(409, "WORKFLOW_JOB", "A workflow step that is already waiting stays on its run");
      }
      await bullJob.remove();
      job.delayMs = input.delayMs;
      job.status = nextStatus;
      await placeOnQueue(job);
      replaced = true;
    }
  }
  if (!replaced) {
    job.delayMs = input.delayMs;
    job.status = nextStatus;
    if (bullJob) await job.save();
    else await placeOnQueue(job);
  }
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.rescheduled",
    targetType: "job",
    targetId: job.publicId,
    metadata: { delayMs: input.delayMs, previousDelayMs },
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function updateJobPriority(
  project: ProjectDoc,
  jobId: string,
  input: { priority: PriorityLabel },
  auth: AuthContext,
) {
  const job = await getJob(project, jobId);
  if (!["waiting", "delayed"].includes(job.status)) {
    throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can change priority");
  }
  const previous = job.priority;
  const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "active") throw new AppError(409, "JOB_NOT_QUEUED", "An active job cannot change priority");
    if (!["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can change priority");
    }
    await bullJob.changePriority({ priority: priorityToBull(input.priority) });
  }
  job.priority = input.priority;
  job.priorityValue = priorityToBull(input.priority);
  if (bullJob) await job.save();
  else await placeOnQueue(job);
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.priority_changed",
    targetType: "job",
    targetId: job.publicId,
    metadata: { priority: input.priority, previous },
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function moveJob(project: ProjectDoc, jobId: string, input: { queue: string }, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (!["waiting", "delayed"].includes(job.status)) {
    throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can move to another queue");
  }
  if (job.workflowRunId) {
    throw new AppError(409, "WORKFLOW_JOB", "A workflow step stays on the queue that owns its run");
  }
  const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
  if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  if (queue.name === job.queueName) return job;
  const previous = job.queueName;
  const previousBull = job.bullQueueName;
  const bullJob = await getBullQueue(previousBull).getJob(job.publicId);
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "active") throw new AppError(409, "JOB_NOT_QUEUED", "An active job cannot move to another queue");
    if (!["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      throw new AppError(409, "JOB_NOT_QUEUED", "Only a waiting or delayed job can move to another queue");
    }
  }
  await assertCapacity(queue);
  if (bullJob) await bullJob.remove();
  job.queueId = queue._id;
  job.queuePublicId = queue.publicId;
  job.queueName = queue.name;
  job.bullQueueName = queue.bullQueueName;
  await placeOnQueue(job);
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.moved",
    targetType: "job",
    targetId: job.publicId,
    metadata: { queue: queue.name, previous },
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: job.status, queue: job.queueName },
  });
  return job;
}

export async function retryFailedJobs(
  project: ProjectDoc,
  input: { queue?: string; limit?: number },
  auth: AuthContext,
) {
  if (input.queue) {
    const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  }
  const limit = Math.min(input.limit ?? 20, DEAD_LETTER_RETRY_LIMIT);
  const failed = await JobRecord.find({
    projectId: project._id,
    status: "failed",
    dismissedAt: null,
    ...(input.queue ? { queueName: input.queue } : {}),
  }).sort({ updatedAt: 1 }).limit(limit);
  const jobIds: string[] = [];
  let skipped = 0;
  for (const record of failed) {
    try {
      await retryJob(project, record.publicId, auth);
      jobIds.push(record.publicId);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { retried: jobIds.length, skipped, jobIds };
}

export async function dismissFailedJobs(
  project: ProjectDoc,
  input: { queue?: string; limit?: number },
  auth: AuthContext,
) {
  if (input.queue) {
    const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  }
  const limit = Math.min(input.limit ?? 20, DEAD_LETTER_RETRY_LIMIT);
  const failed = await JobRecord.find({
    projectId: project._id,
    status: "failed",
    dismissedAt: null,
    ...(input.queue ? { queueName: input.queue } : {}),
  }).sort({ updatedAt: 1 }).limit(limit);
  const jobIds: string[] = [];
  let skipped = 0;
  for (const record of failed) {
    try {
      await dismissJob(project, record.publicId, auth);
      jobIds.push(record.publicId);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { dismissed: jobIds.length, skipped, jobIds };
}

export async function dismissJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (job.status !== "failed") throw new AppError(409, "JOB_NOT_DISMISSIBLE", "Only a failed job can leave the dead letter list");
  if (job.dismissedAt) throw new AppError(409, "JOB_NOT_DISMISSIBLE", "This job is already off the dead letter list");
  job.dismissedAt = new Date();
  await job.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.dismissed",
    targetType: "job",
    targetId: job.publicId,
    metadata: {},
  });
  return job;
}

export async function restoreJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (job.status !== "failed" || !job.dismissedAt) {
    throw new AppError(409, "JOB_NOT_DISMISSIBLE", "This job is still on the dead letter list");
  }
  job.set("dismissedAt", undefined);
  await job.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.restored",
    targetType: "job",
    targetId: job.publicId,
    metadata: {},
  });
  return job;
}

export async function cancelQueuedJobs(
  project: ProjectDoc,
  input: { queue?: string; limit?: number },
  auth: AuthContext,
) {
  if (input.queue) {
    const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  }
  const limit = Math.min(input.limit ?? 20, CANCEL_QUEUED_LIMIT);
  const queued = await JobRecord.find({
    projectId: project._id,
    status: { $in: ["waiting", "delayed"] },
    workflowRunId: null,
    ...(input.queue ? { queueName: input.queue } : {}),
  }).sort({ createdAt: 1 }).limit(limit);
  const jobIds: string[] = [];
  let skipped = 0;
  for (const record of queued) {
    try {
      await cancelJob(project, record.publicId, auth);
      jobIds.push(record.publicId);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { cancelled: jobIds.length, skipped, jobIds };
}

export async function cancelJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (!["waiting", "delayed"].includes(job.status)) {
    throw new AppError(409, "JOB_NOT_CANCELLABLE", "Only waiting or delayed jobs can be cancelled");
  }
  const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "active") throw new AppError(409, "JOB_NOT_CANCELLABLE", "An active job cannot be cancelled safely");
    await bullJob.remove();
  }
  job.status = "cancelled";
  job.completedAt = new Date();
  await job.save();
  await dispatchWebhooks({
    projectId: job.projectId,
    event: "job.cancelled",
    resourceId: job.publicId,
    data: { jobId: job.publicId, queue: job.queueName, name: job.name, status: "cancelled" },
  });
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.cancelled",
    targetType: "job",
    targetId: job.publicId,
    metadata: {},
  });
  await publish({
    type: "job.updated",
    projectId: project.publicId,
    data: { jobId: job.publicId, status: "cancelled", queue: job.queueName },
  });
  return job;
}

export async function removeJob(project: ProjectDoc, jobId: string, auth: AuthContext) {
  const job = await getJob(project, jobId);
  if (job.status === "active") throw new AppError(409, "JOB_NOT_REMOVABLE", "Active jobs cannot be removed");
  const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
  if (bullJob) {
    const state = await bullJob.getState();
    if (state === "active") throw new AppError(409, "JOB_NOT_REMOVABLE", "Active jobs cannot be removed");
    await bullJob.remove();
  }
  if (job.status !== "completed") {
    job.status = "cancelled";
    job.completedAt = job.completedAt ?? new Date();
  }
  job.removedAt = new Date();
  await job.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "job.removed",
    targetType: "job",
    targetId: job.publicId,
    metadata: {},
  });
  return job;
}
