import { redact, shouldApplyJobStatus, type JobStatus, type RealtimeEvent } from "@taskflow/shared";
import { JobAttempt, JobRecord, LogEntry } from "./models.js";
import { logger } from "./logger.js";
import { syncWorkflowRun } from "./workflow-runs.js";
import { dispatchWebhooks } from "./webhooks.js";

function truncate(value: string | undefined, max = 8_000) {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function writeLog(input: {
  projectId: unknown;
  projectPublicId: string;
  level: "info" | "warn" | "error";
  message: string;
  jobPublicId: string;
  workerId?: string;
  traceId?: string;
  durationMs?: number;
}) {
  await LogEntry.create({
    ...input,
    message: input.message,
    timestamp: new Date(),
  });
}

export async function onJobActive(input: {
  publicId: string;
  attempt: number;
  workerId: string;
}): Promise<RealtimeEvent | null> {
  const job = await JobRecord.findOne({ publicId: input.publicId });
  if (!job) {
    logger.warn({ jobId: input.publicId }, "Active event for an unknown job");
    return null;
  }
  if (shouldApplyJobStatus(job.status as JobStatus, "active")) {
    job.status = "active";
  }
  job.attemptsMade = Math.max(job.attemptsMade ?? 0, input.attempt);
  if (!job.startedAt) job.startedAt = new Date();
  await job.save();
  await syncWorkflowRun(job.workflowRunId);
  await JobAttempt.updateOne(
    { jobId: job._id, attemptNumber: input.attempt },
    {
      $setOnInsert: {
        jobId: job._id,
        jobPublicId: job.publicId,
        projectId: job.projectId,
        attemptNumber: input.attempt,
        startedAt: new Date(),
        status: "active",
        workerId: input.workerId,
      },
    },
    { upsert: true },
  );
  await writeLog({
    projectId: job.projectId,
    projectPublicId: job.projectPublicId,
    level: "info",
    message: `Attempt ${input.attempt} started`,
    jobPublicId: job.publicId,
    workerId: input.workerId,
    traceId: job.traceId,
  });
  return {
    type: "job.updated",
    projectId: job.projectPublicId,
    data: { jobId: job.publicId, status: job.status as JobStatus, queue: job.queueName },
  };
}

export async function onJobCompleted(input: {
  publicId: string;
  attempt: number;
  workerId: string;
  result: unknown;
  durationMs: number;
}): Promise<RealtimeEvent | null> {
  const job = await JobRecord.findOne({ publicId: input.publicId });
  if (!job) return null;
  if (shouldApplyJobStatus(job.status as JobStatus, "completed")) {
    job.status = "completed";
    job.result = redact(input.result);
    job.completedAt = new Date();
    job.durationMs = input.durationMs;
    job.attemptsMade = input.attempt;
    job.set("error", undefined);
    await job.save();
  }
  await syncWorkflowRun(job.workflowRunId);
  if (job.status === "completed") await notifyWebhook(job, "job.completed");
  await JobAttempt.updateOne(
    { jobId: job._id, attemptNumber: input.attempt },
    {
      $set: {
        status: "completed",
        workerId: input.workerId,
        finishedAt: new Date(),
        durationMs: input.durationMs,
      },
      $setOnInsert: {
        jobId: job._id,
        jobPublicId: job.publicId,
        projectId: job.projectId,
        attemptNumber: input.attempt,
        startedAt: new Date(),
      },
    },
    { upsert: true },
  );
  await writeLog({
    projectId: job.projectId,
    projectPublicId: job.projectPublicId,
    level: "info",
    message: `Attempt ${input.attempt} completed`,
    jobPublicId: job.publicId,
    workerId: input.workerId,
    traceId: job.traceId,
    durationMs: input.durationMs,
  });
  return {
    type: "job.updated",
    projectId: job.projectPublicId,
    data: {
      jobId: job.publicId,
      status: "completed",
      queue: job.queueName,
      durationMs: input.durationMs,
    },
  };
}

export async function onJobFailed(input: {
  publicId: string;
  attempt: number;
  workerId: string;
  message: string;
  stack?: string;
  durationMs: number;
  nextStatus: Extract<JobStatus, "waiting" | "delayed" | "failed">;
}): Promise<RealtimeEvent | null> {
  const job = await JobRecord.findOne({ publicId: input.publicId });
  if (!job) return null;
  const terminal = input.nextStatus === "failed";
  if (shouldApplyJobStatus(job.status as JobStatus, input.nextStatus)) {
    job.status = input.nextStatus;
    job.attemptsMade = input.attempt;
    job.durationMs = input.durationMs;
    job.error = {
      message: input.message,
      stack: truncate(input.stack),
      code: terminal ? "JOB_FAILED" : "JOB_RETRYING",
    };
    if (terminal) job.completedAt = new Date();
    await job.save();
  }
  await syncWorkflowRun(job.workflowRunId);
  if (terminal && job.status === "failed") await notifyWebhook(job, "job.failed");
  await JobAttempt.updateOne(
    { jobId: job._id, attemptNumber: input.attempt },
    {
      $set: {
        status: "failed",
        workerId: input.workerId,
        finishedAt: new Date(),
        durationMs: input.durationMs,
        errorMessage: input.message,
        errorStack: truncate(input.stack),
      },
      $setOnInsert: {
        jobId: job._id,
        jobPublicId: job.publicId,
        projectId: job.projectId,
        attemptNumber: input.attempt,
        startedAt: new Date(),
      },
    },
    { upsert: true },
  );
  await writeLog({
    projectId: job.projectId,
    projectPublicId: job.projectPublicId,
    level: terminal ? "error" : "warn",
    message: terminal
      ? `Attempt ${input.attempt} failed: ${input.message}`
      : `Attempt ${input.attempt} failed and will retry: ${input.message}`,
    jobPublicId: job.publicId,
    workerId: input.workerId,
    traceId: job.traceId,
    durationMs: input.durationMs,
  });
  return {
    type: "job.updated",
    projectId: job.projectPublicId,
    data: {
      jobId: job.publicId,
      status: input.nextStatus,
      queue: job.queueName,
      durationMs: input.durationMs,
    },
  };
}

async function notifyWebhook(job: { projectId: unknown; publicId: string; queueName: string; name: string; status: string; durationMs?: number; error?: { message?: string }; result?: unknown }, event: "job.completed" | "job.failed") {
  await dispatchWebhooks({
    projectId: job.projectId,
    event,
    resourceId: job.publicId,
    data: {
      jobId: job.publicId,
      queue: job.queueName,
      name: job.name,
      status: job.status,
      durationMs: job.durationMs ?? null,
      error: job.error?.message ?? null,
      result: job.result ?? null,
    },
  }).catch((error) => logger.error({ err: error, jobId: job.publicId }, "Webhook dispatch failed"));
}
