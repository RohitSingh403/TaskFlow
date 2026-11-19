import { deriveWorkerHealth, redact, type JobStatus } from "@taskflow/shared";
import type { JobDoc, QueueDoc } from "@taskflow/server";

export function toUser(user: { publicId: string; name: string; email: string; createdAt?: Date }) {
  return {
    id: user.publicId,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt?.toISOString(),
  };
}

export function toProject(project: {
  publicId: string;
  name: string;
  description?: string;
  environment: string;
  defaultJobSettings?: {
    maxAttempts: number;
    backoffType: string;
    backoffDelayMs: number;
    timeoutMs: number;
    priority: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: project.publicId,
    name: project.name,
    description: project.description ?? "",
    environment: project.environment,
    defaultJobSettings: project.defaultJobSettings,
    createdAt: project.createdAt?.toISOString(),
    updatedAt: project.updatedAt?.toISOString(),
  };
}

export function toQueue(queue: QueueDoc) {
  return {
    id: queue.publicId,
    name: queue.name,
    description: queue.description ?? "",
    concurrency: queue.concurrency,
    maxWaiting: queue.maxWaiting,
    rateLimit: queue.rateLimit ?? null,
    isPaused: queue.isPaused,
    status: queue.isPaused ? "paused" : "running",
    createdAt: queue.createdAt?.toISOString(),
    updatedAt: queue.updatedAt?.toISOString(),
  };
}

export function toJob(job: JobDoc) {
  return {
    id: job.publicId,
    queueId: job.queuePublicId,
    queue: job.queueName,
    name: job.name,
    status: job.status as JobStatus,
    priority: job.priority,
    payload: redact(job.payload),
    metadata: job.metadata ?? {},
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    backoffType: job.backoffType,
    backoffDelayMs: job.backoffDelayMs,
    delayMs: job.delayMs,
    timeoutMs: job.timeoutMs,
    traceId: job.traceId,
    idempotencyKey: job.idempotencyKey ?? null,
    result: job.result === undefined ? null : redact(job.result),
    error: job.error
      ? { message: job.error.message, stack: job.error.stack ?? null, code: job.error.code ?? null }
      : null,
    createdBy: job.createdBy,
    enqueued: job.enqueued,
    createdAt: job.createdAt?.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs: job.durationMs ?? null,
  };
}

export function toWorker(worker: {
  workerId: string;
  hostname: string;
  pid: number;
  assignments: { projectPublicId: string; queuePublicId: string; queueName: string; concurrency: number }[];
  activeJobs: number;
  activeJobIds: string[];
  jobsSucceeded: number;
  jobsFailed: number;
  lastHeartbeatAt: Date;
  startedAt: Date;
  stoppedAt?: Date | null;
}, projectPublicId?: string) {
  const assignments = projectPublicId
    ? worker.assignments.filter((assignment) => assignment.projectPublicId === projectPublicId)
    : worker.assignments;
  return {
    id: worker.workerId,
    hostname: worker.hostname,
    pid: worker.pid,
    health: deriveWorkerHealth(worker.lastHeartbeatAt, Date.now(), Boolean(worker.stoppedAt)),
    queues: assignments.map((assignment) => ({
      id: assignment.queuePublicId,
      name: assignment.queueName,
      concurrency: assignment.concurrency,
    })),
    concurrency: assignments.reduce((sum, assignment) => sum + assignment.concurrency, 0),
    activeJobs: worker.activeJobs,
    activeJobIds: worker.activeJobIds,
    jobsSucceeded: worker.jobsSucceeded,
    jobsFailed: worker.jobsFailed,
    lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
    startedAt: worker.startedAt.toISOString(),
    stoppedAt: worker.stoppedAt?.toISOString() ?? null,
  };
}

export function toApiKey(key: {
  publicId: string;
  name: string;
  description?: string;
  prefix: string;
  scopes: string[];
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  createdAt?: Date;
}) {
  return {
    id: key.publicId,
    name: key.name,
    description: key.description ?? "",
    prefix: key.prefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt?.toISOString(),
    status: key.revokedAt ? "revoked" : "active",
  };
}
