import {
  DEFAULT_MAX_WAITING,
  SCHEDULE_MISSED_GRACE_MS,
  handlerSchemas,
  isHandlerName,
  simulationDecision,
  type RealtimeEvent,
} from "@taskflow/shared";
import { PlanLimitError, assertJobAllowance } from "./billing.js";
import { CronError, nextCronOccurrence } from "./cron.js";
import { createId, isDuplicateKeyError } from "./ids.js";
import { logger } from "./logger.js";
import { JobRecord, Project, QueueConfig, Schedule, type ScheduleDoc } from "./models.js";
import { enqueueJob, getBullQueue } from "./bull.js";

async function backlog(queueName: string) {
  const counts = await getBullQueue(queueName).getJobCounts("waiting", "delayed", "prioritized", "paused");
  return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0);
}

async function createOccurrence(schedule: ScheduleDoc, occurrence: Date) {
  const project = await Project.findById(schedule.projectId);
  if (!project || project.deletedAt) throw new CronError("Project is no longer available");
  const handler = schedule.handler;
  if (!isHandlerName(handler)) throw new CronError("Handler is no longer registered");
  const parsed = handlerSchemas[handler].safeParse(schedule.payload);
  if (!parsed.success) throw new CronError("Stored payload no longer matches the handler");
  const simulation = simulationDecision(project.environment, parsed.data);
  if (!simulation.ok) throw new CronError(simulation.message);

  const idempotencyKey = `sched_${schedule.publicId}_${occurrence.getTime()}`;
  const existing = await JobRecord.findOne({ projectId: schedule.projectId, idempotencyKey });
  if (existing) return existing;

  const job = await JobRecord.create({
    publicId: createId("job"),
    projectId: schedule.projectId,
    projectPublicId: schedule.projectPublicId,
    queueId: schedule.queueId,
    queuePublicId: schedule.queuePublicId,
    queueName: schedule.queueName,
    bullQueueName: schedule.bullQueueName,
    name: handler,
    payload: parsed.data,
    metadata: { scheduleId: schedule.publicId, occurrenceAt: occurrence.toISOString() },
    status: "waiting",
    priority: schedule.priority,
    priorityValue: schedule.priorityValue,
    delayMs: 0,
    timeoutMs: schedule.timeoutMs,
    maxAttempts: schedule.maxAttempts,
    backoffType: schedule.backoffType,
    backoffDelayMs: schedule.backoffDelayMs,
    allowSimulation: project.environment === "development",
    traceId: createId("trace"),
    idempotencyKey,
    requestHash: idempotencyKey,
    scheduleId: schedule.publicId,
    enqueued: false,
    createdBy: { type: "system", id: schedule.publicId, label: schedule.name },
  });

  try {
    await enqueueJob({
      queueName: job.bullQueueName,
      jobName: job.name,
      jobId: job.publicId,
      data: {
        publicId: job.publicId,
        projectObjectId: String(job.projectId),
        projectPublicId: job.projectPublicId,
        queueName: job.queueName,
        handler: job.name,
        payload: job.payload,
        timeoutMs: job.timeoutMs,
        traceId: job.traceId,
        allowSimulation: job.allowSimulation,
      },
      options: {
        attempts: job.maxAttempts,
        backoff: { type: job.backoffType, delay: job.backoffDelayMs },
        priority: job.priorityValue,
        removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
        removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
      },
    });
    job.enqueued = true;
    await job.save();
  } catch (error) {
    const queued = await getBullQueue(job.bullQueueName).getJob(job.publicId).catch(() => null);
    job.enqueued = Boolean(queued);
    if (!queued) {
      job.status = "failed";
      job.completedAt = new Date();
      job.error = { message: "The scheduled job was saved, but Redis did not accept it.", code: "ENQUEUE_FAILED" };
    }
    await job.save();
    if (!queued) throw error;
  }
  return job;
}

/**
 * Produces at most one job per due schedule.
 * A tick older than the grace window is skipped so a restart does not replay a backlog.
 * Only one scheduler should call this. The claim on nextRunAt keeps a second caller from inserting a second job.
 */
export async function produceDueSchedules(now = new Date(), publish?: (event: RealtimeEvent) => Promise<void>) {
  const due = await Schedule.find({
    deletedAt: null,
    paused: false,
    nextRunAt: { $lte: now },
  })
    .sort({ nextRunAt: 1 })
    .limit(25);

  let produced = 0;
  for (const schedule of due) {
    const occurrence = schedule.nextRunAt;
    if (!occurrence) continue;
    const missed = now.getTime() - occurrence.getTime() > SCHEDULE_MISSED_GRACE_MS;
    const following = nextCronOccurrence(schedule.cron, schedule.timeZone, missed ? now : occurrence);
    if (missed) {
      await Schedule.updateOne(
        { _id: schedule._id, nextRunAt: occurrence, paused: false, deletedAt: null },
        { $set: { nextRunAt: following, lastError: "Skipped missed ticks while the scheduler was not running" } },
      );
      continue;
    }

    const project = await Project.findById(schedule.projectId);
    if (project) {
      try {
        await assertJobAllowance(project, 1, now);
      } catch (error) {
        if (error instanceof PlanLimitError) {
          await Schedule.updateOne(
            { _id: schedule._id, nextRunAt: occurrence, paused: false, deletedAt: null },
            { $set: { nextRunAt: following, lastError: error.message } },
          );
          continue;
        }
        throw error;
      }
    }

    const queue = await QueueConfig.findOne({ _id: schedule.queueId, deletedAt: null });
    if (!queue) {
      await Schedule.updateOne({ _id: schedule._id }, { $set: { lastError: "Queue no longer exists" } });
      continue;
    }
    const limit = queue.maxWaiting || DEFAULT_MAX_WAITING;
    if ((await backlog(queue.bullQueueName)) >= limit) continue;

    const claimed = await Schedule.findOneAndUpdate(
      { _id: schedule._id, paused: false, deletedAt: null, nextRunAt: occurrence },
      { $set: { nextRunAt: following, lastError: "" } },
    );
    if (!claimed) continue;

    try {
      const job = await createOccurrence(claimed, occurrence);
      produced += 1;
      await Schedule.updateOne({ _id: schedule._id }, { $set: { lastRunAt: new Date(), lastJobId: job.publicId, lastError: "" } });
      await publish?.({
        type: "job.updated",
        projectId: job.projectPublicId,
        data: { jobId: job.publicId, status: job.status, queue: job.queueName },
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) continue;
      const message = error instanceof Error ? error.message : "Could not create the scheduled job";
      logger.error({ err: error, scheduleId: schedule.publicId }, "Scheduled occurrence failed");
      await Schedule.updateOne(
        { _id: schedule._id, nextRunAt: following },
        { $set: { nextRunAt: occurrence, lastError: message } },
      );
    }
  }
  return { produced };
}
