import {
  AuditLog,
  PlanLimitError,
  assertJobAllowance,
  JobRecord,
  QueueConfig,
  Workflow,
  WorkflowRun,
  addJobFlow,
  createId,
  getBullQueue,
  isDuplicateKeyError,
  type JobDoc,
  type ProjectDoc,
  type QueueDoc,
  type WorkflowDoc,
  type WorkflowRunDoc,
} from "@taskflow/server";
import {
  DEFAULT_MAX_WAITING,
  MAX_PAYLOAD_BYTES,
  MAX_WORKFLOWS_PER_PROJECT,
  PAUSE_WORKFLOWS_LIMIT,
  RESUME_WORKFLOWS_LIMIT,
  findUnsafeKey,
  handlerSchemas,
  isHandlerName,
  priorityToBull,
  simulationDecision,
  validateWorkflowGraph,
  type HandlerName,
  type PriorityLabel,
} from "@taskflow/shared";
import type { FlowJob, JobsOptions } from "bullmq";
import { AppError } from "../../errors.js";
import { cancelJob } from "../jobs/jobs.service.js";
import { publish } from "../../infrastructure.js";
import { zodDetails } from "../../middleware/common.js";
import type { AuthContext } from "../../types.js";

export interface WorkflowStepInput {
  key: string;
  handler: string;
  queue: string;
  payload: Record<string, unknown>;
  dependsOn: string[];
}

export interface WorkflowInput {
  name: string;
  description?: string;
  steps: WorkflowStepInput[];
}

interface StoredStep {
  key: string;
  handler: string;
  queueName: string;
  queuePublicId: string;
  bullQueueName: string;
  payload: Record<string, unknown>;
  dependsOn: string[];
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
    jobId: job.publicId,
    attempts: job.maxAttempts,
    backoff: { type: job.backoffType, delay: job.backoffDelayMs },
    priority: job.priorityValue,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
  };
}

export async function listWorkflows(project: ProjectDoc) {
  const workflows = await Workflow.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: -1 }) as WorkflowDoc[];
  const summaries = await Promise.all(workflows.map(async (workflow) => {
    const [runCount, lastRun] = await Promise.all([
      WorkflowRun.countDocuments({ workflowId: workflow._id }),
      WorkflowRun.findOne({ workflowId: workflow._id }).sort({ createdAt: -1 }) as Promise<WorkflowRunDoc | null>,
    ]);
    return { workflow, runCount, lastRun };
  }));
  return summaries;
}

export async function getWorkflow(project: ProjectDoc, workflowId: string) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  const [runCount, runs] = await Promise.all([
    WorkflowRun.countDocuments({ workflowId: workflow._id }),
    WorkflowRun.find({ workflowId: workflow._id }).sort({ createdAt: -1 }).limit(20) as Promise<WorkflowRunDoc[]>,
  ]);
  return { workflow, runCount, lastRun: runs[0] ?? null, runs };
}

async function prepareSteps(project: ProjectDoc, steps: WorkflowStepInput[]) {
  const graph = validateWorkflowGraph(steps);
  if (!graph.ok) throw new AppError(400, "WORKFLOW_INVALID", graph.message);
  const prepared: StoredStep[] = [];
  for (const step of steps) {
    if (!isHandlerName(step.handler)) throw new AppError(400, "HANDLER_NOT_FOUND", `Unknown handler on step "${step.key}"`);
    const handler = step.handler as HandlerName;
    const unsafe = findUnsafeKey(step.payload);
    if (unsafe) throw new AppError(400, "VALIDATION_ERROR", `Unsafe payload key at ${unsafe}`);
    if (Buffer.byteLength(JSON.stringify(step.payload)) > MAX_PAYLOAD_BYTES) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", `Step "${step.key}" exceeds the 256 KB payload limit`);
    }
    const parsed = handlerSchemas[handler].safeParse(step.payload);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", `Payload for step "${step.key}" is invalid`, zodDetails(parsed.error));
    }
    const simulation = simulationDecision(project.environment, parsed.data);
    if (!simulation.ok) throw new AppError(400, "SIMULATION_DISABLED", simulation.message);
    const queue = await QueueConfig.findOne({ projectId: project._id, name: step.queue, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", `Queue "${step.queue}" was not found`);
    prepared.push({
      key: step.key,
      handler,
      queueName: queue.name,
      queuePublicId: queue.publicId,
      bullQueueName: queue.bullQueueName,
      payload: parsed.data as Record<string, unknown>,
      dependsOn: step.dependsOn,
    });
  }
  return prepared;
}

export async function createWorkflow(project: ProjectDoc, input: WorkflowInput, auth: AuthContext) {
  const count = await Workflow.countDocuments({ projectId: project._id, deletedAt: null });
  if (count >= MAX_WORKFLOWS_PER_PROJECT) {
    throw new AppError(409, "WORKFLOW_LIMIT", `A project can keep ${MAX_WORKFLOWS_PER_PROJECT} workflows`);
  }
  const prepared = await prepareSteps(project, input.steps);

  try {
    const workflow = await Workflow.create({
      publicId: createId("wf"),
      projectId: project._id,
      projectPublicId: project.publicId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      steps: prepared,
      createdBy: actor(auth),
    });
    await AuditLog.create({
      projectId: project._id,
      actorType: auth.type,
      actorId: auth.userPublicId,
      action: "workflow.created",
      targetType: "workflow",
      targetId: workflow.publicId,
      metadata: { steps: prepared.length },
    });
    return workflow;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "WORKFLOW_EXISTS", "A workflow with this name already exists");
    throw error;
  }
}

export async function updateWorkflow(
  project: ProjectDoc,
  workflowId: string,
  input: { name?: string; description?: string; steps?: WorkflowStepInput[] },
  auth: AuthContext,
) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  const previousName = workflow.name;
  const previousDescription = workflow.description ?? "";
  const previousSteps = workflow.steps.map((step) => step.key);
  if (input.name) workflow.name = input.name.trim();
  if (typeof input.description === "string") workflow.description = input.description.trim();
  if (input.steps) {
    workflow.set("steps", await prepareSteps(project, input.steps));
  }
  try {
    await workflow.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "WORKFLOW_EXISTS", "A workflow with this name already exists");
    throw error;
  }
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "workflow.updated",
    targetType: "workflow",
    targetId: workflow.publicId,
    metadata: {
      ...(workflow.name !== previousName ? { name: workflow.name, previousName } : {}),
      ...(workflow.description !== previousDescription ? { description: workflow.description, previousDescription } : {}),
      ...(input.steps ? { steps: workflow.steps.map((step) => step.key), previousSteps } : {}),
    },
  });
  return workflow;
}

export async function setWorkflowPaused(project: ProjectDoc, workflowId: string, paused: boolean, auth: AuthContext) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  if (Boolean(workflow.paused) === paused) {
    throw new AppError(
      409,
      paused ? "WORKFLOW_PAUSED" : "WORKFLOW_NOT_PAUSED",
      paused ? "This workflow is already paused" : "This workflow is not paused",
    );
  }
  workflow.paused = paused;
  await workflow.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: paused ? "workflow.paused" : "workflow.resumed",
    targetType: "workflow",
    targetId: workflow.publicId,
    metadata: { name: workflow.name },
  });
  return workflow;
}

export async function pauseWorkflows(project: ProjectDoc, input: { limit?: number }, auth: AuthContext) {
  const limit = Math.min(input.limit ?? 20, PAUSE_WORKFLOWS_LIMIT);
  const running = await Workflow.find({
    projectId: project._id,
    deletedAt: null,
    paused: false,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const workflowIds: string[] = [];
  let skipped = 0;
  for (const workflow of running) {
    try {
      await setWorkflowPaused(project, workflow.publicId, true, auth);
      workflowIds.push(workflow.publicId);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { paused: workflowIds.length, skipped, workflowIds };
}

export async function resumeWorkflows(project: ProjectDoc, input: { limit?: number }, auth: AuthContext) {
  const limit = Math.min(input.limit ?? 20, RESUME_WORKFLOWS_LIMIT);
  const paused = await Workflow.find({
    projectId: project._id,
    deletedAt: null,
    paused: true,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const workflowIds: string[] = [];
  let skipped = 0;
  for (const workflow of paused) {
    try {
      await setWorkflowPaused(project, workflow.publicId, false, auth);
      workflowIds.push(workflow.publicId);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { resumed: workflowIds.length, skipped, workflowIds };
}

export async function deleteWorkflow(project: ProjectDoc, workflowId: string, auth: AuthContext) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  workflow.deletedAt = new Date();
  await workflow.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "workflow.deleted",
    targetType: "workflow",
    targetId: workflow.publicId,
    metadata: {},
  });
}

export async function startWorkflowRun(project: ProjectDoc, workflowId: string, auth: AuthContext) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  if (workflow.paused) throw new AppError(409, "WORKFLOW_PAUSED", "This workflow is paused. Resume it before starting a run.");
  try {
    await assertJobAllowance(project, workflow.steps.length);
  } catch (error) {
    if (error instanceof PlanLimitError) throw new AppError(402, "PLAN_LIMIT", error.message);
    throw error;
  }
  const queues = new Map<string, QueueDoc>();
  for (const step of workflow.steps) {
    if (queues.has(step.queueName)) continue;
    const queue = await QueueConfig.findOne({ projectId: project._id, publicId: step.queuePublicId, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", `Queue "${step.queueName}" was not found`);
    await assertCapacity(queue);
    queues.set(step.queueName, queue);
  }

  const settings = {
    priority: project.defaultJobSettings?.priority ?? "medium",
    maxAttempts: project.defaultJobSettings?.maxAttempts ?? 3,
    backoffType: project.defaultJobSettings?.backoffType ?? "exponential",
    backoffDelayMs: project.defaultJobSettings?.backoffDelayMs ?? 5_000,
    timeoutMs: project.defaultJobSettings?.timeoutMs ?? 30_000,
  } as const;

  const steps = workflow.steps.map((step): StoredStep => ({
    key: step.key,
    handler: step.handler,
    queueName: step.queueName,
    queuePublicId: step.queuePublicId,
    bullQueueName: step.bullQueueName,
    payload: step.payload as Record<string, unknown>,
    dependsOn: [...step.dependsOn],
  }));

  const run = await WorkflowRun.create({
    publicId: createId("run"),
    projectId: project._id,
    projectPublicId: project.publicId,
    workflowId: workflow._id,
    workflowPublicId: workflow.publicId,
    status: "waiting",
    steps: steps.map((step) => ({
      key: step.key,
      handler: step.handler,
      queueName: step.queueName,
      dependsOn: step.dependsOn,
      jobId: createId("job"),
    })),
    startedAt: new Date(),
  }) as WorkflowRunDoc;

  const jobs: JobDoc[] = [];
  try {
    for (const step of steps) {
      const snapshot = run.steps.find((entry) => entry.key === step.key);
      const queue = queues.get(step.queueName);
      if (!snapshot || !queue) throw new Error(`Missing step ${step.key}`);
      jobs.push(await JobRecord.create({
        publicId: snapshot.jobId,
        projectId: project._id,
        projectPublicId: project.publicId,
        queueId: queue._id,
        queuePublicId: queue.publicId,
        queueName: queue.name,
        bullQueueName: queue.bullQueueName,
        name: step.handler,
        payload: step.payload,
        metadata: {},
        status: "waiting",
        priority: settings.priority,
        priorityValue: priorityToBull(settings.priority as PriorityLabel),
        delayMs: 0,
        timeoutMs: settings.timeoutMs,
        maxAttempts: settings.maxAttempts,
        backoffType: settings.backoffType,
        backoffDelayMs: settings.backoffDelayMs,
        allowSimulation: project.environment === "development",
        traceId: createId("trace"),
        enqueued: false,
        workflowRunId: run.publicId,
        workflowStepKey: step.key,
        createdBy: actor(auth),
      }));
    }
    const byKey = new Map(steps.map((step) => [step.key, step]));
    const jobByKey = new Map(jobs.map((job) => [job.workflowStepKey ?? "", job]));
    const graph = validateWorkflowGraph(steps.map((step) => ({ key: step.key, dependsOn: [...step.dependsOn] })));
    if (!graph.ok) throw new AppError(400, "WORKFLOW_INVALID", graph.message);
    await addJobFlow(flowNode(graph.root, byKey, jobByKey));
    for (const job of jobs) {
      job.enqueued = true;
      await job.save();
      await publish({
        type: "job.updated",
        projectId: project.publicId,
        data: { jobId: job.publicId, status: job.status, queue: job.queueName },
      });
    }
  } catch (error) {
    await failRecordedRun(run, jobs);
    if (error instanceof AppError) throw error;
    throw new AppError(503, "ENQUEUE_FAILED", "The workflow run was recorded but Redis did not accept the flow");
  }

  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "workflow.run",
    targetType: "workflow_run",
    targetId: run.publicId,
    metadata: { workflowId: workflow.publicId },
  });
  return { run, jobs };
}

function flowNode(
  key: string,
  steps: Map<string, StoredStep>,
  jobs: Map<string, JobDoc>,
): FlowJob {
  const step = steps.get(key);
  const job = jobs.get(key);
  if (!step || !job) throw new Error(`Missing flow node ${key}`);
  const children = step.dependsOn.map((dependency) => flowNode(dependency, steps, jobs));
  return {
    name: job.name,
    queueName: job.bullQueueName,
    data: executionData(job),
    opts: executionOptions(job),
    children: children.length > 0 ? children : undefined,
  };
}

async function failRecordedRun(run: WorkflowRunDoc, jobs: JobDoc[]) {
  const finished = new Date();
  for (const job of jobs) {
    job.status = "failed";
    job.enqueued = false;
    job.completedAt = finished;
    job.error = { message: "The workflow record was saved, but Redis did not accept the flow.", code: "ENQUEUE_FAILED" };
    await job.save();
  }
  run.status = "failed";
  run.completedAt = finished;
  run.durationMs = finished.getTime() - run.startedAt.getTime();
  await run.save();
}

async function assertCapacity(queue: QueueDoc) {
  const counts = await getBullQueue(queue.bullQueueName).getJobCounts("waiting", "delayed", "prioritized", "paused");
  const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0);
  const limit = queue.maxWaiting || DEFAULT_MAX_WAITING;
  if (backlog >= limit) {
    throw new AppError(429, "QUEUE_BACKPRESSURE", "A queue in this workflow is at its waiting-job limit");
  }
}

export async function listWorkflowRuns(project: ProjectDoc, workflowId: string) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  return WorkflowRun.find({ workflowId: workflow._id }).sort({ createdAt: -1 }).limit(20) as Promise<WorkflowRunDoc[]>;
}

export async function cancelWorkflowRun(project: ProjectDoc, workflowId: string, runId: string, auth: AuthContext) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  const run = await WorkflowRun.findOne({ workflowId: workflow._id, publicId: runId }) as WorkflowRunDoc | null;
  if (!run) throw new AppError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found");
  if (run.status === "cancelled") throw new AppError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "This run is already cancelled");
  if (run.status === "completed") throw new AppError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "This run has already finished");

  const jobs = await JobRecord.find({ workflowRunId: run.publicId }) as JobDoc[];
  if (jobs.some((job) => job.status === "active")) {
    throw new AppError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "An active step cannot be cancelled safely");
  }
  const waiting = jobs.filter((job) => job.status === "waiting" || job.status === "delayed");
  if (waiting.length === 0) throw new AppError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "This run has already finished");
  for (const job of waiting) {
    const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
    if (bullJob && (await bullJob.getState()) === "active") {
      throw new AppError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "An active step cannot be cancelled safely");
    }
  }

  const dependedOn = new Set(run.steps.flatMap((step) => step.dependsOn));
  const ordered = [
    ...run.steps.filter((step) => !dependedOn.has(step.key)),
    ...run.steps.filter((step) => dependedOn.has(step.key)),
  ];
  const byKey = new Map(waiting.map((job) => [job.workflowStepKey, job]));
  let cancelled = 0;
  for (const step of ordered) {
    const job = byKey.get(step.key);
    if (!job) continue;
    await cancelJob(project, job.publicId, auth);
    cancelled += 1;
  }

  const finished = new Date();
  run.status = "cancelled";
  run.completedAt = finished;
  run.durationMs = finished.getTime() - run.startedAt.getTime();
  run.set("failedStepKey", undefined);
  await run.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "workflow.cancelled",
    targetType: "workflow_run",
    targetId: run.publicId,
    metadata: { workflowId: workflow.publicId, cancelled },
  });
  return getWorkflowRun(project, workflowId, runId);
}

export async function getWorkflowRun(project: ProjectDoc, workflowId: string, runId: string) {
  const workflow = await Workflow.findOne({ projectId: project._id, publicId: workflowId, deletedAt: null }) as WorkflowDoc | null;
  if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  const run = await WorkflowRun.findOne({ workflowId: workflow._id, publicId: runId }) as WorkflowRunDoc | null;
  if (!run) throw new AppError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found");
  const jobs = await JobRecord.find({ workflowRunId: run.publicId });
  return { run, jobs };
}
