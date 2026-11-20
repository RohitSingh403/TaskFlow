import { HEARTBEAT_UNHEALTHY_MS, type AlertType } from "@taskflow/shared";
import { getBullQueue } from "./bull.js";
import { dispatchWebhooks } from "./webhooks.js";
import { createId } from "./ids.js";
import { logger } from "./logger.js";
import { AlertEvent, AlertRule, JobRecord, QueueConfig, WorkerRecord, type AlertRuleDoc } from "./models.js";

export interface FiredAlert {
  projectId: string;
  alertId: string;
  ruleId: string;
  alertType: AlertType;
}

export async function evaluateAlerts(now = new Date()): Promise<FiredAlert[]> {
  const rules = await AlertRule.find({ enabled: true, deletedAt: null }).sort({ lastTriggeredAt: 1 }).limit(50);
  const fired: FiredAlert[] = [];
  for (const rule of rules) {
    if (rule.lastTriggeredAt && now.getTime() - rule.lastTriggeredAt.getTime() < rule.cooldownMs) continue;
    const finding = await inspectRule(rule, now);
    if (!finding) {
      if (rule.lastError) {
        rule.lastError = "";
        await rule.save();
      }
      continue;
    }
    if (finding.error) {
      rule.lastError = finding.error;
      await rule.save();
      continue;
    }
    const claimed = await AlertRule.findOneAndUpdate(
      {
        _id: rule._id,
        enabled: true,
        deletedAt: null,
        $or: [{ lastTriggeredAt: null }, { lastTriggeredAt: { $lte: new Date(now.getTime() - rule.cooldownMs) } }],
      },
      { $set: { lastTriggeredAt: now, lastError: "" } },
    );
    if (!claimed) continue;
    const event = await AlertEvent.create({
      publicId: createId("alert"),
      projectId: rule.projectId,
      projectPublicId: rule.projectPublicId,
      ruleId: rule._id,
      rulePublicId: rule.publicId,
      type: rule.type,
      title: finding.title,
      message: finding.message,
      status: "open",
    });
    fired.push({
      projectId: rule.projectPublicId,
      alertId: event.publicId,
      ruleId: rule.publicId,
      alertType: rule.type as AlertType,
    });
    await dispatchWebhooks({
      projectId: rule.projectId,
      event: "alert.fired",
      resourceId: event.publicId,
      data: {
        alertId: event.publicId,
        ruleId: rule.publicId,
        alertType: rule.type,
        title: finding.title,
        message: finding.message,
      },
    }).catch((error) => logger.error({ err: error, alertId: event.publicId }, "Webhook dispatch failed"));
  }
  return fired;
}

interface Finding {
  title: string;
  message: string;
  error?: string;
}

async function inspectRule(rule: AlertRuleDoc, now: Date): Promise<Finding | null> {
  if (rule.type === "queue.backlog") return backlogFinding(rule);
  if (rule.type === "failure.rate") return failureFinding(rule, now);
  if (rule.type === "worker.offline") return workerFinding(rule, now);
  if (rule.type === "job.long_running") return longRunningFinding(rule, now);
  return { title: "", message: "", error: "Unknown alert type" };
}

async function backlogFinding(rule: AlertRuleDoc): Promise<Finding | null> {
  const queue = await QueueConfig.findOne({ projectId: rule.projectId, name: rule.queueName, deletedAt: null });
  if (!queue) return { title: "", message: "", error: `Queue "${rule.queueName ?? ""}" was not found` };
  const counts = await getBullQueue(queue.bullQueueName).getJobCounts("waiting", "delayed", "prioritized", "paused");
  const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0);
  if (backlog < rule.threshold) return null;
  return {
    title: `${queue.name} backlog is ${backlog}`,
    message: `Queue ${queue.name} has ${backlog} jobs waiting. This rule fires at ${rule.threshold}.`,
  };
}

async function failureFinding(rule: AlertRuleDoc, now: Date): Promise<Finding | null> {
  const since = new Date(now.getTime() - (rule.windowMs ?? 15 * 60 * 1000));
  const filter: Record<string, unknown> = {
    projectId: rule.projectId,
    status: { $in: ["completed", "failed"] },
    completedAt: { $gte: since },
  };
  if (rule.queueName) filter.queueName = rule.queueName;
  const [sample, failed] = await Promise.all([
    JobRecord.countDocuments(filter),
    JobRecord.countDocuments({ ...filter, status: "failed" }),
  ]);
  const minimum = rule.minSamples ?? 5;
  if (sample < minimum) return null;
  const rate = Math.round((failed / sample) * 100);
  if (rate < rule.threshold) return null;
  const windowMinutes = Math.round((rule.windowMs ?? 15 * 60 * 1000) / 60_000);
  return {
    title: `Failure rate is ${rate}%`,
    message: `${failed} of ${sample} finished jobs failed in the last ${windowMinutes} minutes${rule.queueName ? ` on ${rule.queueName}` : ""}. This rule fires at ${rule.threshold}%.`,
  };
}

async function workerFinding(rule: AlertRuleDoc, now: Date): Promise<Finding | null> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_UNHEALTHY_MS);
  const workers = await WorkerRecord.find({
    "assignments.projectId": rule.projectId,
    $or: [{ stoppedAt: { $type: "date" } }, { lastHeartbeatAt: { $lte: cutoff } }],
  }).limit(5);
  if (workers.length === 0) return null;
  const names = workers.map((worker) => worker.workerId).join(", ");
  return {
    title: workers.length === 1 ? `${workers[0]?.workerId ?? "A worker"} is offline` : `${workers.length} workers are offline`,
    message: `Workers assigned to this project are offline: ${names}. A worker is offline when it stops or its heartbeat is older than ${HEARTBEAT_UNHEALTHY_MS / 1000} seconds.`,
  };
}

async function longRunningFinding(rule: AlertRuleDoc, now: Date): Promise<Finding | null> {
  const filter: Record<string, unknown> = {
    projectId: rule.projectId,
    status: "active",
    startedAt: { $lte: new Date(now.getTime() - rule.threshold) },
  };
  if (rule.queueName) filter.queueName = rule.queueName;
  const jobs = await JobRecord.find(filter).sort({ startedAt: 1 }).limit(5);
  if (jobs.length === 0) return null;
  const seconds = Math.round(rule.threshold / 1000);
  return {
    title: jobs.length === 1 ? `${jobs[0]?.publicId ?? "A job"} is still running` : `${jobs.length} jobs are still running`,
    message: `${jobs.map((job) => job.publicId).join(", ")} ${jobs.length === 1 ? "has" : "have"} been active for longer than ${seconds} seconds.`,
  };
}
