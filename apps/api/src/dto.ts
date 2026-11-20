import { deriveWorkerHealth, redact, validateWorkflowGraph, type JobStatus } from "@taskflow/shared";
import type { AlertEventDoc, AlertRuleDoc, JobDoc, QueueDoc, ScheduleDoc, WorkflowDoc, WorkflowRunDoc } from "@taskflow/server";

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

export function toSchedule(schedule: ScheduleDoc) {
  return {
    id: schedule.publicId,
    name: schedule.name,
    description: schedule.description ?? "",
    queueId: schedule.queuePublicId,
    queue: schedule.queueName,
    handler: schedule.handler,
    payload: redact(schedule.payload),
    cron: schedule.cron,
    timeZone: schedule.timeZone,
    priority: schedule.priority,
    maxAttempts: schedule.maxAttempts,
    backoffType: schedule.backoffType,
    backoffDelayMs: schedule.backoffDelayMs,
    timeoutMs: schedule.timeoutMs,
    paused: schedule.paused,
    status: schedule.paused ? "paused" : "active",
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastJobId: schedule.lastJobId ?? null,
    lastError: schedule.lastError || null,
    createdAt: schedule.createdAt?.toISOString(),
  };
}

export function toWorkflow(
  workflow: WorkflowDoc,
  extras?: { runCount?: number; lastRun?: WorkflowRunDoc | null },
) {
  const graph = validateWorkflowGraph(workflow.steps.map((step) => ({ key: step.key, dependsOn: [...step.dependsOn] })));
  return {
    id: workflow.publicId,
    name: workflow.name,
    description: workflow.description ?? "",
    root: graph.ok ? graph.root : null,
    executionOrder: graph.ok ? graph.executionOrder : workflow.steps.map((step) => step.key),
    steps: workflow.steps.map((step) => ({
      key: step.key,
      handler: step.handler,
      queue: step.queueName,
      dependsOn: [...step.dependsOn],
      payload: redact(step.payload),
    })),
    runCount: extras?.runCount ?? 0,
    lastRun: extras?.lastRun ? toWorkflowRun(extras.lastRun) : null,
    createdAt: workflow.createdAt?.toISOString(),
    updatedAt: workflow.updatedAt?.toISOString(),
  };
}

export function toWorkflowRun(run: WorkflowRunDoc, jobs: JobDoc[] = []) {
  const byId = new Map(jobs.map((job) => [job.publicId, job]));
  return {
    id: run.publicId,
    workflowId: run.workflowPublicId,
    status: run.status,
    failedStepKey: run.failedStepKey ?? null,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: run.durationMs ?? null,
    createdAt: run.createdAt?.toISOString(),
    steps: run.steps.map((step) => {
      const job = byId.get(step.jobId);
      return {
        key: step.key,
        handler: step.handler,
        queue: step.queueName,
        dependsOn: [...step.dependsOn],
        jobId: step.jobId,
        status: job?.status ?? "waiting",
        error: job?.error?.message ?? null,
        durationMs: job?.durationMs ?? null,
        startedAt: job?.startedAt?.toISOString() ?? null,
        completedAt: job?.completedAt?.toISOString() ?? null,
      };
    }),
  };
}

export function toAlertRule(rule: AlertRuleDoc) {
  return {
    id: rule.publicId,
    name: rule.name,
    type: rule.type,
    enabled: rule.enabled,
    queue: rule.queueName ?? null,
    threshold: rule.threshold,
    windowMs: rule.windowMs ?? null,
    minSamples: rule.minSamples ?? null,
    cooldownMs: rule.cooldownMs,
    lastTriggeredAt: rule.lastTriggeredAt?.toISOString() ?? null,
    lastError: rule.lastError || null,
    createdAt: rule.createdAt?.toISOString(),
  };
}

export function toAlert(alert: AlertEventDoc) {
  return {
    id: alert.publicId,
    ruleId: alert.rulePublicId,
    type: alert.type,
    title: alert.title,
    message: alert.message,
    status: alert.status,
    createdAt: alert.createdAt?.toISOString(),
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
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
