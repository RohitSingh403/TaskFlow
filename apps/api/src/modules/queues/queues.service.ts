import { DELETE_QUEUES_LIMIT, PAUSE_QUEUES_LIMIT, RESUME_QUEUES_LIMIT } from "@taskflow/shared";
import { AuditLog, bullQueueName, createId, getBullQueue, QueueConfig, Schedule, Workflow, type ProjectDoc, type QueueDoc } from "@taskflow/server";
import { AppError } from "../../errors.js";
import { publish } from "../../infrastructure.js";

export async function listQueues(project: ProjectDoc) {
  return QueueConfig.find({ projectId: project._id, deletedAt: null }).sort({ name: 1 });
}

export async function createQueue(
  project: ProjectDoc,
  input: {
    name: string;
    description?: string;
    concurrency: number;
    maxWaiting: number;
    rateLimit?: { max: number; duration: number } | null;
  },
  actorId: string,
) {
  const existing = await QueueConfig.findOne({ projectId: project._id, name: input.name, deletedAt: null });
  if (existing) throw new AppError(409, "QUEUE_EXISTS", "A queue with that name already exists in this project");
  const queue = await QueueConfig.create({
    publicId: createId("queue"),
    projectId: project._id,
    projectPublicId: project.publicId,
    name: input.name,
    description: input.description ?? "",
    concurrency: input.concurrency,
    maxWaiting: input.maxWaiting,
    rateLimit: input.rateLimit ?? null,
    isPaused: false,
    bullQueueName: bullQueueName(project.publicId, input.name),
  });
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: "queue.created",
    targetType: "queue",
    targetId: queue.publicId,
    metadata: { name: queue.name },
  });
  return queue;
}

export async function updateQueue(project: ProjectDoc, queue: QueueDoc, input: Record<string, unknown>, actorId: string) {
  if (typeof input.description === "string") queue.description = input.description;
  if (typeof input.concurrency === "number") queue.concurrency = input.concurrency;
  if (typeof input.maxWaiting === "number") queue.maxWaiting = input.maxWaiting;
  if ("rateLimit" in input) queue.rateLimit = (input.rateLimit as QueueDoc["rateLimit"]) ?? null;
  await queue.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: "queue.updated",
    targetType: "queue",
    targetId: queue.publicId,
    metadata: { fields: Object.keys(input) },
  });
  return queue;
}

export async function setQueuePaused(project: ProjectDoc, queue: QueueDoc, paused: boolean, actorId: string) {
  queue.isPaused = paused;
  await queue.save();
  const bull = getBullQueue(queue.bullQueueName);
  if (paused) await bull.pause();
  else await bull.resume();
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: paused ? "queue.paused" : "queue.resumed",
    targetType: "queue",
    targetId: queue.publicId,
    metadata: { name: queue.name },
  });
  await publish({
    type: "queue.updated",
    projectId: project.publicId,
    data: { queueId: queue.publicId, isPaused: paused },
  });
  return queue;
}

export async function pauseQueues(project: ProjectDoc, input: { limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, PAUSE_QUEUES_LIMIT);
  const running = await QueueConfig.find({
    projectId: project._id,
    deletedAt: null,
    isPaused: false,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const queueIds: string[] = [];
  let skipped = 0;
  for (const queue of running) {
    try {
      const current = await findQueue(project, queue.publicId);
      if (current.isPaused) {
        skipped += 1;
        continue;
      }
      await setQueuePaused(project, current, true, actorId);
      queueIds.push(current.publicId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { paused: queueIds.length, skipped, queueIds };
}

export async function resumeQueues(project: ProjectDoc, input: { limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, RESUME_QUEUES_LIMIT);
  const paused = await QueueConfig.find({
    projectId: project._id,
    deletedAt: null,
    isPaused: true,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const queueIds: string[] = [];
  let skipped = 0;
  for (const queue of paused) {
    try {
      const current = await findQueue(project, queue.publicId);
      if (!current.isPaused) {
        skipped += 1;
        continue;
      }
      await setQueuePaused(project, current, false, actorId);
      queueIds.push(current.publicId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { resumed: queueIds.length, skipped, queueIds };
}

export async function deleteQueues(project: ProjectDoc, input: { limit?: number }, actorId: string) {
  const limit = Math.min(input.limit ?? 20, DELETE_QUEUES_LIMIT);
  const selected = await QueueConfig.find({
    projectId: project._id,
    deletedAt: null,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const queueIds: string[] = [];
  let skipped = 0;
  for (const queue of selected) {
    try {
      const current = await QueueConfig.findOne({
        projectId: project._id,
        publicId: queue.publicId,
        deletedAt: null,
      });
      if (!current) {
        skipped += 1;
        continue;
      }
      await deleteQueue(project, current, actorId);
      queueIds.push(current.publicId);
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { deleted: queueIds.length, skipped, queueIds };
}

export async function deleteQueue(project: ProjectDoc, queue: QueueDoc, actorId: string) {
  const stats = await queueStats(queue);
  if (stats.waiting + stats.active + stats.delayed + stats.paused > 0) {
    throw new AppError(409, "QUEUE_NOT_EMPTY", "Drain waiting, delayed, and active jobs before deleting this queue. Pausing the queue is not enough.");
  }
  const schedule = await Schedule.exists({ projectId: project._id, queuePublicId: queue.publicId, deletedAt: null });
  if (schedule) throw new AppError(409, "QUEUE_IN_USE", "A schedule still uses this queue");
  const workflow = await Workflow.exists({ projectId: project._id, deletedAt: null, "steps.queuePublicId": queue.publicId });
  if (workflow) throw new AppError(409, "QUEUE_IN_USE", "A workflow still uses this queue");
  queue.deletedAt = new Date();
  queue.isPaused = true;
  await queue.save();
  await getBullQueue(queue.bullQueueName).pause();
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId,
    action: "queue.deleted",
    targetType: "queue",
    targetId: queue.publicId,
    metadata: { name: queue.name },
  });
}

export async function queueStats(queue: QueueDoc) {
  const counts = await getBullQueue(queue.bullQueueName).getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "paused",
    "prioritized",
    "waiting-children",
  );
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts["waiting-children"] ?? 0),
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0,
  };
}

export async function findQueue(project: ProjectDoc, queueId: string) {
  const queue = await QueueConfig.findOne({ projectId: project._id, publicId: queueId, deletedAt: null });
  if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", "Queue not found");
  return queue;
}
