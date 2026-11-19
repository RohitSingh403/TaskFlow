import { JobRecord, QueueConfig, WorkerRecord, type ProjectDoc } from "@taskflow/server";
import { deriveWorkerHealth, PERCENTILE_SAMPLE_LIMIT, summarizeDurations, throughputBucket } from "@taskflow/shared";
import { queueStats } from "../queues/queues.service.js";

export async function analyticsOverview(project: ProjectDoc, range: { from: Date; to: Date }) {
  const grouped = await JobRecord.aggregate<{ _id: string; count: number }>([
    { $match: { projectId: project._id, createdAt: { $gte: range.from, $lte: range.to } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(grouped.map((row) => [row._id, row.count]));
  const completed = byStatus.completed ?? 0;
  const failed = byStatus.failed ?? 0;
  const terminal = completed + failed;
  const samples = await JobRecord.find({
    projectId: project._id,
    status: "completed",
    completedAt: { $gte: range.from, $lte: range.to },
    durationMs: { $type: "number" },
  })
    .sort({ completedAt: -1 })
    .limit(PERCENTILE_SAMPLE_LIMIT)
    .select("durationMs")
    .lean<{ durationMs: number }[]>();

  const queues = await QueueConfig.find({ projectId: project._id, deletedAt: null });
  const queueHealth = [];
  const live = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  for (const queue of queues) {
    const stats = await queueStats(queue);
    live.waiting += stats.waiting;
    live.active += stats.active;
    live.delayed += stats.delayed;
    live.failed += stats.failed;
    live.completed += stats.completed;
    queueHealth.push({
      id: queue.publicId,
      name: queue.name,
      status: queue.isPaused ? "paused" : "running",
      concurrency: queue.concurrency,
      ...stats,
    });
  }

  const workers = await WorkerRecord.find({ "assignments.projectPublicId": project.publicId });
  const workerSummary = workers.map((worker) => ({
    id: worker.workerId,
    health: deriveWorkerHealth(worker.lastHeartbeatAt, Date.now(), Boolean(worker.stoppedAt)),
    activeJobs: worker.activeJobs,
    hostname: worker.hostname,
  }));

  const recentFailures = await JobRecord.find({ projectId: project._id, status: "failed" })
    .sort({ completedAt: -1, updatedAt: -1 })
    .limit(6)
    .select("publicId name queueName error completedAt attemptsMade maxAttempts");

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      submitted: grouped.reduce((sum, row) => sum + row.count, 0),
      completed,
      failed,
      waiting: (byStatus.waiting ?? 0) + (byStatus.delayed ?? 0),
      active: byStatus.active ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      failureRate: terminal === 0 ? 0 : failed / terminal,
    },
    latency: summarizeDurations(samples.map((sample) => sample.durationMs)),
    latencySampleCapped: samples.length >= PERCENTILE_SAMPLE_LIMIT,
    live,
    workers: {
      total: workerSummary.length,
      online: workerSummary.filter((worker) => worker.health === "online").length,
      unhealthy: workerSummary.filter((worker) => worker.health === "unhealthy").length,
      items: workerSummary,
    },
    queues: queueHealth,
    recentFailures: recentFailures.map((job) => ({
      id: job.publicId,
      name: job.name,
      queue: job.queueName,
      message: job.error?.message ?? "Failed",
      attempts: `${job.attemptsMade}/${job.maxAttempts}`,
      completedAt: job.completedAt?.toISOString() ?? null,
    })),
  };
}

export async function throughput(project: ProjectDoc, range: { from: Date; to: Date }) {
  const bucket = throughputBucket(range.to.getTime() - range.from.getTime());
  const rows = await JobRecord.aggregate<{ _id: Date; total: number; completed: number; failed: number }>([
    { $match: { projectId: project._id, createdAt: { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: "$createdAt", unit: bucket.unit, binSize: bucket.binSize } },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return {
    bucket,
    points: rows.map((row) => ({
      at: new Date(row._id).toISOString(),
      total: row.total,
      completed: row.completed,
      failed: row.failed,
    })),
  };
}

export async function latencySeries(project: ProjectDoc, range: { from: Date; to: Date }) {
  const bucket = throughputBucket(range.to.getTime() - range.from.getTime());
  const rows = await JobRecord.aggregate<{ _id: Date; avg: number; count: number }>([
    {
      $match: {
        projectId: project._id,
        status: "completed",
        completedAt: { $gte: range.from, $lte: range.to },
        durationMs: { $type: "number" },
      },
    },
    {
      $group: {
        _id: { $dateTrunc: { date: "$completedAt", unit: bucket.unit, binSize: bucket.binSize } },
        avg: { $avg: "$durationMs" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const samples = await JobRecord.find({
    projectId: project._id,
    status: "completed",
    completedAt: { $gte: range.from, $lte: range.to },
    durationMs: { $type: "number" },
  })
    .sort({ completedAt: -1 })
    .limit(PERCENTILE_SAMPLE_LIMIT)
    .select("durationMs")
    .lean<{ durationMs: number }[]>();
  return {
    bucket,
    summary: summarizeDurations(samples.map((sample) => sample.durationMs)),
    points: rows.map((row) => ({ at: new Date(row._id).toISOString(), avgMs: row.avg, count: row.count })),
  };
}

export async function failureBreakdown(project: ProjectDoc, range: { from: Date; to: Date }) {
  const rows = await JobRecord.aggregate<{ _id: string; queue: string; count: number }>([
    { $match: { projectId: project._id, status: "failed", createdAt: { $gte: range.from, $lte: range.to } } },
    { $group: { _id: { name: "$name", queue: "$queueName" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 8 },
  ]);
  return rows.map((row) => ({
    name: row._id && typeof row._id === "object" ? (row._id as { name?: string }).name : String(row._id),
    queue: row._id && typeof row._id === "object" ? (row._id as { queue?: string }).queue : undefined,
    count: row.count,
  }));
}
