import {
  AuditLog,
  Webhook,
  WebhookDelivery,
  WebhookDeliveryError,
  WebhookUrlError,
  assertWebhookUrl,
  createId,
  createWebhookSecret,
  queueWebhookTest,
  requeueWebhookDelivery,
  type ProjectDoc,
  type WebhookDeliveryDoc,
  type WebhookDoc,
} from "@taskflow/server";
import { MAX_WEBHOOKS_PER_PROJECT, type WebhookEvent } from "@taskflow/shared";
import { AppError } from "../../errors.js";
import type { AuthContext } from "../../types.js";

function actor(auth: AuthContext) {
  return {
    type: auth.type,
    id: auth.type === "api_key" ? auth.apiKeyId ?? auth.userPublicId : auth.userPublicId,
    label: auth.label,
  };
}

async function checkedUrl(project: ProjectDoc, url: string) {
  try {
    return (await assertWebhookUrl(url, project.environment)).toString();
  } catch (error) {
    if (error instanceof WebhookUrlError) throw new AppError(400, "WEBHOOK_URL", error.message);
    throw error;
  }
}

export async function listWebhooks(project: ProjectDoc) {
  return Webhook.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: -1 }) as Promise<WebhookDoc[]>;
}

export async function createWebhook(
  project: ProjectDoc,
  input: { url: string; description?: string; events: WebhookEvent[] },
  auth: AuthContext,
) {
  const count = await Webhook.countDocuments({ projectId: project._id, deletedAt: null });
  if (count >= MAX_WEBHOOKS_PER_PROJECT) {
    throw new AppError(409, "WEBHOOK_LIMIT", `A project can keep ${MAX_WEBHOOKS_PER_PROJECT} webhooks`);
  }
  const url = await checkedUrl(project, input.url);
  const signing = createWebhookSecret();
  const webhook = await Webhook.create({
    publicId: createId("wh"),
    projectId: project._id,
    projectPublicId: project.publicId,
    url,
    description: input.description?.trim() ?? "",
    events: input.events,
    secret: signing.secret,
    secretPrefix: signing.prefix,
    enabled: true,
    createdBy: actor(auth),
  });
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "webhook.created",
    targetType: "webhook",
    targetId: webhook.publicId,
    metadata: { events: input.events },
  });
  return { webhook: webhook as WebhookDoc, secret: signing.secret };
}

export async function updateWebhook(
  project: ProjectDoc,
  webhookId: string,
  input: { url?: string; description?: string; events?: WebhookEvent[]; enabled?: boolean },
  auth: AuthContext,
) {
  const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null }) as WebhookDoc | null;
  if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
  if (input.url) webhook.url = await checkedUrl(project, input.url);
  if (typeof input.description === "string") webhook.description = input.description.trim();
  if (input.events) webhook.events = input.events;
  if (typeof input.enabled === "boolean") webhook.enabled = input.enabled;
  await webhook.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "webhook.updated",
    targetType: "webhook",
    targetId: webhook.publicId,
    metadata: {},
  });
  return webhook;
}

export async function rotateWebhookSecret(project: ProjectDoc, webhookId: string, auth: AuthContext) {
  const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null }) as WebhookDoc | null;
  if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
  const signing = createWebhookSecret();
  webhook.secret = signing.secret;
  webhook.secretPrefix = signing.prefix;
  await webhook.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "webhook.rotated",
    targetType: "webhook",
    targetId: webhook.publicId,
    metadata: {},
  });
  return { webhook, secret: signing.secret };
}

export async function sendTestWebhook(project: ProjectDoc, webhookId: string, auth: AuthContext) {
  const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null }) as WebhookDoc | null;
  if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
  try {
    const delivery = await queueWebhookTest(webhook);
    await AuditLog.create({
      projectId: project._id,
      actorType: auth.type,
      actorId: auth.userPublicId,
      action: "webhook.tested",
      targetType: "webhook_delivery",
      targetId: delivery.publicId,
      metadata: { webhookId: webhook.publicId },
    });
    return delivery;
  } catch (error) {
    if (error instanceof WebhookDeliveryError && error.code === "WEBHOOK_DISABLED") {
      throw new AppError(409, "WEBHOOK_DISABLED", "The webhook endpoint is disabled");
    }
    throw error;
  }
}

export async function deleteWebhook(project: ProjectDoc, webhookId: string, auth: AuthContext) {
  const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null }) as WebhookDoc | null;
  if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
  webhook.deletedAt = new Date();
  webhook.enabled = false;
  await webhook.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "webhook.deleted",
    targetType: "webhook",
    targetId: webhook.publicId,
    metadata: {},
  });
}

export async function redeliverWebhook(project: ProjectDoc, webhookId: string, deliveryId: string, auth: AuthContext) {
  const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null });
  if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
  const delivery = await WebhookDelivery.findOne({ projectId: project._id, webhookId: webhook._id, publicId: deliveryId });
  if (!delivery) throw new AppError(404, "DELIVERY_NOT_FOUND", "Webhook delivery not found");
  try {
    const queued = await requeueWebhookDelivery(delivery);
    await AuditLog.create({
      projectId: project._id,
      actorType: auth.type,
      actorId: auth.userPublicId,
      action: "webhook.redelivered",
      targetType: "webhook_delivery",
      targetId: queued.publicId,
      metadata: { webhookId: webhook.publicId },
    });
    return queued;
  } catch (error) {
    if (error instanceof WebhookDeliveryError && error.code === "WEBHOOK_DISABLED") {
      throw new AppError(409, "WEBHOOK_DISABLED", "The webhook endpoint is disabled");
    }
    if (error instanceof WebhookDeliveryError) {
      throw new AppError(409, "DELIVERY_PENDING", "This delivery is already in progress");
    }
    throw error;
  }
}

export async function listWebhookDeliveries(project: ProjectDoc, webhookId?: string) {
  const filter: Record<string, unknown> = { projectId: project._id };
  if (webhookId) {
    const webhook = await Webhook.findOne({ projectId: project._id, publicId: webhookId, deletedAt: null });
    if (!webhook) throw new AppError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
    filter.webhookId = webhook._id;
  }
  return WebhookDelivery.find(filter).sort({ createdAt: -1 }).limit(20) as Promise<WebhookDeliveryDoc[]>;
}
