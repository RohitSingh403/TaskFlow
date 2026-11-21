import {
  AlertEvent,
  AlertRule,
  AuditLog,
  QueueConfig,
  createId,
  isDuplicateKeyError,
  type AlertEventDoc,
  type AlertRuleDoc,
  type ProjectDoc,
} from "@taskflow/server";
import { MAX_ALERT_RULES_PER_PROJECT, type AlertType } from "@taskflow/shared";
import { AppError } from "../../errors.js";
import type { AuthContext } from "../../types.js";

export interface AlertRuleInput {
  type: AlertType;
  name: string;
  queue?: string;
  threshold?: number;
  windowMs?: number;
  minSamples?: number;
  cooldownMs: number;
  enabled: boolean;
}

function actor(auth: AuthContext) {
  return {
    type: auth.type,
    id: auth.type === "api_key" ? auth.apiKeyId ?? auth.userPublicId : auth.userPublicId,
    label: auth.label,
  };
}

export async function listAlertRules(project: ProjectDoc) {
  return AlertRule.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: -1 }) as Promise<AlertRuleDoc[]>;
}

export async function createAlertRule(project: ProjectDoc, input: AlertRuleInput, auth: AuthContext) {
  const count = await AlertRule.countDocuments({ projectId: project._id, deletedAt: null });
  if (count >= MAX_ALERT_RULES_PER_PROJECT) {
    throw new AppError(409, "ALERT_LIMIT", `A project can keep ${MAX_ALERT_RULES_PER_PROJECT} alert rules`);
  }
  if (input.queue) {
    const queue = await QueueConfig.findOne({ projectId: project._id, name: input.queue, deletedAt: null });
    if (!queue) throw new AppError(404, "QUEUE_NOT_FOUND", `Queue "${input.queue}" was not found`);
  }
  try {
    const rule = await AlertRule.create({
      publicId: createId("rule"),
      projectId: project._id,
      projectPublicId: project.publicId,
      name: input.name.trim(),
      type: input.type,
      enabled: input.enabled,
      queueName: input.queue,
      threshold: input.threshold ?? 0,
      windowMs: input.windowMs,
      minSamples: input.minSamples,
      cooldownMs: input.cooldownMs,
      createdBy: actor(auth),
    });
    await AuditLog.create({
      projectId: project._id,
      actorType: auth.type,
      actorId: auth.userPublicId,
      action: "alert_rule.created",
      targetType: "alert_rule",
      targetId: rule.publicId,
      metadata: { type: input.type },
    });
    return rule as AlertRuleDoc;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "ALERT_EXISTS", "An alert rule with this name already exists");
    throw error;
  }
}

export async function updateAlertRule(
  project: ProjectDoc,
  ruleId: string,
  input: { name?: string; enabled?: boolean; threshold?: number; windowMs?: number; minSamples?: number; cooldownMs?: number },
  auth: AuthContext,
) {
  const rule = await AlertRule.findOne({ projectId: project._id, publicId: ruleId, deletedAt: null }) as AlertRuleDoc | null;
  if (!rule) throw new AppError(404, "ALERT_NOT_FOUND", "Alert rule not found");
  if (input.threshold !== undefined) {
    if (rule.type === "worker.offline") throw new AppError(400, "VALIDATION_ERROR", "An offline-worker rule has no threshold");
    if (rule.type === "failure.rate" && input.threshold > 100) throw new AppError(400, "VALIDATION_ERROR", "Failure rate is a percentage from 1 to 100");
    if (rule.type === "job.long_running" && input.threshold < 10_000) throw new AppError(400, "VALIDATION_ERROR", "A long-running alert needs at least 10 seconds");
    rule.threshold = input.threshold;
  }
  if (input.name) rule.name = input.name.trim();
  if (typeof input.enabled === "boolean") rule.enabled = input.enabled;
  if (input.windowMs !== undefined) {
    if (rule.type !== "failure.rate") throw new AppError(400, "VALIDATION_ERROR", "Only a failure-rate rule has a window");
    rule.windowMs = input.windowMs;
  }
  if (input.minSamples !== undefined) {
    if (rule.type !== "failure.rate") throw new AppError(400, "VALIDATION_ERROR", "Only a failure-rate rule has a sample minimum");
    rule.minSamples = input.minSamples;
  }
  if (input.cooldownMs !== undefined) rule.cooldownMs = input.cooldownMs;
  try {
    await rule.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError(409, "ALERT_EXISTS", "An alert rule with this name already exists");
    throw error;
  }
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "alert_rule.updated",
    targetType: "alert_rule",
    targetId: rule.publicId,
    metadata: {},
  });
  return rule;
}

export async function deleteAlertRule(project: ProjectDoc, ruleId: string, auth: AuthContext) {
  const rule = await AlertRule.findOne({ projectId: project._id, publicId: ruleId, deletedAt: null }) as AlertRuleDoc | null;
  if (!rule) throw new AppError(404, "ALERT_NOT_FOUND", "Alert rule not found");
  rule.deletedAt = new Date();
  rule.enabled = false;
  await rule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "alert_rule.deleted",
    targetType: "alert_rule",
    targetId: rule.publicId,
    metadata: {},
  });
}

export async function listAlerts(project: ProjectDoc, query: { status?: string; limit: number }) {
  const filter: Record<string, unknown> = { projectId: project._id };
  if (query.status) filter.status = query.status;
  return AlertEvent.find(filter).sort({ createdAt: -1 }).limit(query.limit) as Promise<AlertEventDoc[]>;
}

export async function resolveAlert(project: ProjectDoc, alertId: string, auth: AuthContext) {
  const alert = await AlertEvent.findOne({ projectId: project._id, publicId: alertId }) as AlertEventDoc | null;
  if (!alert) throw new AppError(404, "ALERT_NOT_FOUND", "Alert not found");
  if (alert.status === "resolved") return alert;
  alert.status = "resolved";
  alert.resolvedAt = new Date();
  await alert.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "alert.resolved",
    targetType: "alert",
    targetId: alert.publicId,
    metadata: {},
  });
  return alert;
}

export async function silenceAlertRule(project: ProjectDoc, ruleId: string, durationMs: number, auth: AuthContext, now = new Date()) {
  const rule = await AlertRule.findOne({ projectId: project._id, publicId: ruleId, deletedAt: null }) as AlertRuleDoc | null;
  if (!rule) throw new AppError(404, "ALERT_NOT_FOUND", "Alert rule not found");
  rule.silencedUntil = new Date(now.getTime() + durationMs);
  await rule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "alert_rule.silenced",
    targetType: "alert_rule",
    targetId: rule.publicId,
    metadata: { until: rule.silencedUntil.toISOString(), durationMs },
  });
  return rule;
}

export async function unsilenceAlertRule(project: ProjectDoc, ruleId: string, auth: AuthContext) {
  const rule = await AlertRule.findOne({ projectId: project._id, publicId: ruleId, deletedAt: null }) as AlertRuleDoc | null;
  if (!rule) throw new AppError(404, "ALERT_NOT_FOUND", "Alert rule not found");
  rule.silencedUntil = null;
  await rule.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "alert_rule.unsilenced",
    targetType: "alert_rule",
    targetId: rule.publicId,
    metadata: {},
  });
  return rule;
}
