import { writeFile } from "node:fs/promises";
import os from "node:os";
import { EVENTS_CHANNEL, WEBHOOK_QUEUE, mapBullState, shouldApplyJobStatus, type JobStatus, type RealtimeEvent } from "@taskflow/shared";
import {
  closeBullQueues,
  configureBull,
  createId,
  createRedis,
  ensureIndexes,
  enqueueJob,
  getBullConnection,
  getBullPrefix,
  getBullQueue,
  JobRecord,
  logger,
  onJobActive,
  onJobCompleted,
  onJobFailed,
  QueueConfig,
  redisOptionsFromUrl,
  WorkerRecord,
  deliverWebhook,
  repairWebhookDeliveries,
} from "@taskflow/server";
import { Worker, type Job } from "bullmq";
import mongoose from "mongoose";
import { runHandlerWithTimeout, type WorkerJobData } from "./handlers.js";

interface RuntimeOptions {
  mongoUri: string;
  redisUrl: string;
  bullPrefix: string;
  workerId?: string;
  pollMs?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
}

interface ManagedWorker {
  worker: Worker;
  signature: string;
  queuePublicId: string;
  paused: boolean;
}

export async function startWorkerRuntime(options: RuntimeOptions) {
  configureBull(redisOptionsFromUrl(options.redisUrl), options.bullPrefix);
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(options.mongoUri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 10 });
  }
  await ensureIndexes();
  const publisher = createRedis(options.redisUrl);
  const workerId = options.workerId || createId("wrk");
  const hostname = os.hostname();
  const pid = process.pid;
  const active = new Set<string>();
  let jobsSucceeded = 0;
  let jobsFailed = 0;
  let stopped = false;
  const managed = new Map<string, ManagedWorker>();
  const webhookWorker = new Worker(
    WEBHOOK_QUEUE,
    async (job) => {
      const deliveryId = String((job.data as { deliveryId?: string }).deliveryId ?? "");
      await deliverWebhook(deliveryId, job.attemptsMade + 1);
    },
    { connection: getBullConnection(), prefix: getBullPrefix(), concurrency: 5 },
  );
  webhookWorker.on("failed", (job, error) => {
    logger.error({ err: error, deliveryId: job?.id }, "Webhook delivery attempt failed");
  });
  webhookWorker.on("error", (error) => {
    logger.error({ err: error, workerId }, "Webhook worker connection error");
  });

  async function publish(event: RealtimeEvent) {
    await publisher.publish(EVENTS_CHANNEL, JSON.stringify(event));
  }

  function bind(worker: Worker) {
    worker.on("active", (job) => {
      void (async () => {
        if (!job.id) return;
        active.add(job.id);
        const event = await onJobActive({
          publicId: job.id,
          attempt: job.attemptsMade + 1,
          workerId,
        });
        if (event) await publish(event);
      })().catch((error) => logger.error({ err: error, jobId: job.id }, "Failed to record active job"));
    });
    worker.on("completed", (job, result) => {
      void (async () => {
        if (job.id) active.delete(job.id);
        jobsSucceeded += 1;
        const durationMs = Math.max(0, (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now()));
        const event = await onJobCompleted({
          publicId: job.id ?? "",
          attempt: Math.max(1, job.attemptsMade),
          workerId,
          result,
          durationMs,
        });
        if (event) await publish(event);
      })().catch((error) => logger.error({ err: error, jobId: job.id }, "Failed to record completed job"));
    });
    worker.on("failed", (job, error) => {
      void (async () => {
        if (!job?.id) return;
        active.delete(job.id);
        const maxAttempts = job.opts.attempts ?? 1;
        const willRetry = job.attemptsMade < maxAttempts;
        if (!willRetry) jobsFailed += 1;
        const state = willRetry ? mapBullState(await job.getState()) : "failed";
        const nextStatus = state === "delayed" || state === "waiting" || state === "failed" ? state : "waiting";
        const durationMs = Math.max(0, (job.finishedOn ?? Date.now()) - (job.processedOn ?? job.timestamp));
        const event = await onJobFailed({
          publicId: job.id,
          attempt: Math.max(1, job.attemptsMade),
          workerId,
          message: error.message,
          stack: error.stack,
          durationMs,
          nextStatus,
        });
        if (event) await publish(event);
      })().catch((err) => logger.error({ err, jobId: job?.id }, "Failed to record failed job"));
    });
    worker.on("stalled", (jobId) => {
      logger.warn({ jobId, workerId }, "Job stalled and will be recovered by the queue");
    });
    worker.on("error", (error) => {
      logger.error({ err: error, workerId }, "Worker connection error");
    });
  }

  async function processJob(job: Job) {
    // BullMQ increments attemptsMade after the attempt finishes, so the in-flight attempt is +1.
    return runHandlerWithTimeout(job.data as WorkerJobData, job.attemptsMade + 1);
  }

  async function convergePause(bull: ReturnType<typeof getBullQueue>, desiredPaused: boolean) {
    const actual = await bull.isPaused();
    if (actual === desiredPaused) return;
    if (desiredPaused) await bull.pause();
    else await bull.resume();
    const confirmed = await QueueConfig.findOne({ bullQueueName: bull.name }).select("isPaused deletedAt");
    if (!confirmed || confirmed.deletedAt) return;
    const after = await bull.isPaused();
    if (after !== confirmed.isPaused) {
      if (confirmed.isPaused) await bull.pause();
      else await bull.resume();
    }
  }

  async function syncQueues() {
    if (stopped) return;
    const queues = await QueueConfig.find({ deletedAt: null });
    const seen = new Set<string>();
    const starting: Worker[] = [];
    for (const queue of queues) {
      const fresh = await QueueConfig.findById(queue._id);
      if (!fresh || fresh.deletedAt) continue;
      seen.add(fresh.bullQueueName);
      const signature = `${fresh.concurrency}:${fresh.rateLimit?.max ?? 0}:${fresh.rateLimit?.duration ?? 0}`;
      const bull = getBullQueue(fresh.bullQueueName);
      const current = managed.get(fresh.bullQueueName);
      await convergePause(bull, fresh.isPaused);
      if (current?.signature === signature) {
        current.paused = fresh.isPaused;
        continue;
      }
      if (current) {
        await current.worker.close();
        managed.delete(fresh.bullQueueName);
      }
      const worker = new Worker(fresh.bullQueueName, processJob, {
        connection: getBullConnection(),
        prefix: getBullPrefix(),
        concurrency: fresh.concurrency,
        limiter: fresh.rateLimit ? { max: fresh.rateLimit.max, duration: fresh.rateLimit.duration } : undefined,
        lockDuration: options.lockDurationMs ?? 30_000,
        stalledInterval: options.stalledIntervalMs ?? 30_000,
        autorun: false,
      });
      bind(worker);
      managed.set(fresh.bullQueueName, {
        worker,
        signature,
        queuePublicId: fresh.publicId,
        paused: fresh.isPaused,
      });
      starting.push(worker);
      logger.info({ queue: fresh.name, projectId: fresh.projectPublicId, concurrency: fresh.concurrency }, "Worker attached to queue");
    }
    let removed = false;
    for (const [name, current] of managed) {
      if (seen.has(name)) continue;
      await current.worker.close();
      managed.delete(name);
      removed = true;
    }
    if (starting.length > 0 || removed) await heartbeat();
    for (const worker of starting) void worker.run();
  }

  async function heartbeat() {
    const queueIds = [...managed.values()].map((entry) => entry.queuePublicId);
    const queues = await QueueConfig.find({ publicId: { $in: queueIds }, deletedAt: null });
    const assignments = queues.map((queue) => ({
      projectId: queue.projectId,
      projectPublicId: queue.projectPublicId,
      queuePublicId: queue.publicId,
      queueName: queue.name,
      bullQueueName: queue.bullQueueName,
      concurrency: queue.concurrency,
    }));
    await WorkerRecord.updateOne(
      { workerId },
      {
        $set: {
          hostname,
          pid,
          assignments,
          activeJobs: active.size,
          activeJobIds: [...active],
          jobsSucceeded,
          jobsFailed,
          lastHeartbeatAt: new Date(),
          stoppedAt: null,
        },
        $setOnInsert: { startedAt: new Date() },
      },
      { upsert: true },
    );
    const projectIds = [...new Set(assignments.map((assignment) => assignment.projectPublicId))];
    if (projectIds.length > 0) {
      await publish({ type: "worker.updated", projectIds, data: { workerId, health: "online" } });
    }
    await writeFile("/tmp/taskflow-worker-alive", String(Date.now())).catch(() => undefined);
  }

  async function sweep() {
    const pending = await JobRecord.find({
      enqueued: false,
      status: { $in: ["waiting", "delayed"] },
      createdAt: { $lt: new Date(Date.now() - 10_000) },
    }).limit(25);
    for (const job of pending) {
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
            delay: job.delayMs > 0 ? job.delayMs : undefined,
            priority: job.priorityValue,
          },
        });
        job.enqueued = true;
        await job.save();
        logger.info({ jobId: job.publicId }, "Re-enqueued a job that never reached Redis");
      } catch (error) {
        logger.error({ err: error, jobId: job.publicId }, "Enqueue repair failed");
      }
    }

    const drifting = await JobRecord.find({
      enqueued: true,
      status: { $in: ["waiting", "delayed", "active"] },
      updatedAt: { $lt: new Date(Date.now() - 20_000) },
    }).limit(50);
    for (const job of drifting) {
      const bullJob = await getBullQueue(job.bullQueueName).getJob(job.publicId);
      if (!bullJob) continue;
      const mapped = mapBullState(await bullJob.getState());
      if (!shouldApplyJobStatus(job.status as JobStatus, mapped) || mapped === job.status) continue;
      job.status = mapped;
      job.attemptsMade = bullJob.attemptsMade;
      if (mapped === "completed") {
        job.result = bullJob.returnvalue;
        job.completedAt = new Date(bullJob.finishedOn ?? Date.now());
        if (bullJob.finishedOn && bullJob.processedOn) job.durationMs = bullJob.finishedOn - bullJob.processedOn;
        job.set("error", undefined);
      }
      if (mapped === "failed") {
        job.error = { message: bullJob.failedReason || "Job failed", code: "JOB_FAILED" };
        job.completedAt = new Date(bullJob.finishedOn ?? Date.now());
      }
      await job.save();
    }
  }

  await syncQueues();
  await heartbeat();
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        await syncQueues();
        await heartbeat();
      } catch (error) {
        logger.error({ err: error }, "Worker poll failed");
      } finally {
        polling = false;
      }
    })();
  }, options.pollMs ?? 5_000);
  const sweeper = setInterval(() => {
    void sweep()
      .then(() => repairWebhookDeliveries())
      .catch((error) => logger.error({ err: error }, "Recovery sweep failed"));
  }, 15_000);

  logger.info({ workerId, hostname, pid }, "TaskFlow worker running");

  return {
    workerId,
    async stop() {
      stopped = true;
      clearInterval(poll);
      clearInterval(sweeper);
      const deadline = Date.now() + 2_000;
      while (polling && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await WorkerRecord.updateOne(
        { workerId },
        { $set: { stoppedAt: new Date(), activeJobs: 0, activeJobIds: [], lastHeartbeatAt: new Date() } },
      );
      await webhookWorker.close();
      await Promise.all([...managed.values()].map((entry) => entry.worker.close()));
      managed.clear();
      await closeBullQueues();
      await publisher.quit();
    },
  };
}
