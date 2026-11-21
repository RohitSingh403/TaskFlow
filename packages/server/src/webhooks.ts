import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_QUEUE,
  WEBHOOK_TEST_EVENT,
  WEBHOOK_TIMEOUT_MS,
  redact,
  type ProjectEnvironment,
  type WebhookEvent,
} from "@taskflow/shared";
import { enqueueJob, getBullQueue } from "./bull.js";
import { createId, isDuplicateKeyError, randomToken } from "./ids.js";
import { logger } from "./logger.js";
import { Project, Webhook, WebhookDelivery, type WebhookDeliveryDoc, type WebhookDoc } from "./models.js";

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

export class WebhookDeliveryError extends Error {
  constructor(public code: "DELIVERY_PENDING" | "WEBHOOK_DISABLED") {
    super(code);
    this.name = "WebhookDeliveryError";
  }
}

export function createWebhookSecret() {
  const secret = `whsec_${randomToken(24)}`;
  return { secret, prefix: `${secret.slice(0, 12)}…` };
}

export function signWebhook(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function isPrivateAddress(address: string) {
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (mapped === "::1" || mapped === "0.0.0.0" || mapped === "::") return true;
  const lower = mapped.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (mapped.startsWith("127.") || mapped.startsWith("10.") || mapped.startsWith("192.168.") || mapped.startsWith("169.254.")) return true;
  const match = /^172\.(\d+)\./.exec(mapped);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export async function assertWebhookUrl(raw: string, environment: ProjectEnvironment) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("Webhook URL is not valid");
  }
  if (url.username || url.password) throw new WebhookUrlError("Webhook URL cannot include credentials");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:") {
    if (!(environment === "development" && loopback)) {
      throw new WebhookUrlError("HTTP webhooks are only allowed to localhost on a development project");
    }
  } else if (url.protocol !== "https:") {
    throw new WebhookUrlError("Webhook URL must use https");
  }
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new WebhookUrlError("Webhook host did not resolve");
  for (const address of addresses) {
    if (isPrivateAddress(address) && !(environment === "development" && loopback)) {
      throw new WebhookUrlError("Webhook URL must not target a private network address");
    }
  }
  return url;
}

export interface WebhookDispatch {
  projectId: unknown;
  event: WebhookEvent;
  resourceId: string;
  data: Record<string, unknown>;
}

export async function dispatchWebhooks(input: WebhookDispatch) {
  const hooks = await Webhook.find({ projectId: input.projectId, enabled: true, deletedAt: null, events: input.event });
  for (const hook of hooks) {
    const deliveryId = createId("whd");
    const body = {
      id: deliveryId,
      event: input.event,
      createdAt: new Date().toISOString(),
      data: redact(input.data),
    };
    try {
      const delivery = await WebhookDelivery.create({
        publicId: deliveryId,
        projectId: hook.projectId,
        projectPublicId: hook.projectPublicId,
        webhookId: hook._id,
        webhookPublicId: hook.publicId,
        event: input.event,
        resourceId: input.resourceId,
        body,
        status: "pending",
        attempts: [],
        enqueued: false,
      });
      await placeDelivery(delivery);
    } catch (error) {
      if (isDuplicateKeyError(error)) continue;
      logger.error({ err: error, webhookId: hook.publicId, event: input.event }, "Failed to record a webhook delivery");
    }
  }
}

export async function requeueWebhookDelivery(delivery: WebhookDeliveryDoc) {
  if (delivery.status === "pending") throw new WebhookDeliveryError("DELIVERY_PENDING");
  const hook = await Webhook.findById(delivery.webhookId);
  if (!hook || hook.deletedAt || !hook.enabled) throw new WebhookDeliveryError("WEBHOOK_DISABLED");
  const queue = getBullQueue(WEBHOOK_QUEUE);
  const existing = await queue.getJob(delivery.publicId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active") throw new WebhookDeliveryError("DELIVERY_PENDING");
    await existing.remove();
  }
  await WebhookDelivery.updateOne(
    { _id: delivery._id },
    { $set: { status: "pending", enqueued: false }, $unset: { completedAt: 1 } },
  );
  const fresh = await WebhookDelivery.findById(delivery._id);
  if (!fresh) throw new WebhookDeliveryError("DELIVERY_PENDING");
  await placeDelivery(fresh);
  return fresh;
}

export async function queueWebhookTest(webhook: WebhookDoc) {
  if (!webhook.enabled || webhook.deletedAt) throw new WebhookDeliveryError("WEBHOOK_DISABLED");
  const deliveryId = createId("whd");
  const delivery = await WebhookDelivery.create({
    publicId: deliveryId,
    projectId: webhook.projectId,
    projectPublicId: webhook.projectPublicId,
    webhookId: webhook._id,
    webhookPublicId: webhook.publicId,
    event: WEBHOOK_TEST_EVENT,
    resourceId: deliveryId,
    body: {
      id: deliveryId,
      event: WEBHOOK_TEST_EVENT,
      createdAt: new Date().toISOString(),
      data: { webhookId: webhook.publicId, test: true },
    },
    status: "pending",
    attempts: [],
    enqueued: false,
  });
  await placeDelivery(delivery);
  return delivery;
}

async function placeDelivery(delivery: WebhookDeliveryDoc) {
  const delay = Number(process.env.WEBHOOK_BACKOFF_MS ?? 5_000);
  const attempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? WEBHOOK_MAX_ATTEMPTS);
  await enqueueJob({
    queueName: WEBHOOK_QUEUE,
    jobName: "deliver",
    jobId: delivery.publicId,
    data: { deliveryId: delivery.publicId },
    options: {
      attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: Number.isFinite(delay) && delay >= 0 ? delay : 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
    },
  });
  delivery.enqueued = true;
  await delivery.save();
}

export async function deliverWebhook(deliveryId: string, attemptNumber: number) {
  const delivery = await WebhookDelivery.findOne({ publicId: deliveryId });
  if (!delivery || delivery.status !== "pending") return;
  const hook = await Webhook.findById(delivery.webhookId);
  const project = hook ? await Project.findById(hook.projectId) : null;
  const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? WEBHOOK_MAX_ATTEMPTS);
  const started = Date.now();
  try {
    if (!hook || !hook.enabled || hook.deletedAt || !project) {
      throw new Error("The webhook endpoint is disabled");
    }
    const url = await assertWebhookUrl(hook.url, project.environment);
    const raw = JSON.stringify(delivery.body);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(hook.secret, timestamp, raw);
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "taskflow-delivery": delivery.publicId,
        "taskflow-event": delivery.event,
        "taskflow-timestamp": String(timestamp),
        "taskflow-signature": `t=${timestamp},v1=${signature}`,
      },
      body: raw,
    });
    const durationMs = Date.now() - started;
    if (response.status >= 300 && response.status < 400) {
      recordAttempt(delivery, { statusCode: response.status, error: "Redirects are not followed", durationMs });
    } else if (response.ok) {
      recordAttempt(delivery, { statusCode: response.status, error: "", durationMs });
      delivery.status = "succeeded";
      delivery.completedAt = new Date();
      await delivery.save();
      return;
    } else {
      recordAttempt(delivery, { statusCode: response.status, error: `HTTP ${response.status}`, durationMs });
    }
  } catch (error) {
    recordAttempt(delivery, {
      error: error instanceof Error ? error.message : "Delivery failed",
      durationMs: Date.now() - started,
    });
  }
  if (attemptNumber >= maxAttempts || delivery.attempts.at(-1)?.error === "The webhook endpoint is disabled") {
    delivery.status = "failed";
    delivery.completedAt = new Date();
    await delivery.save();
    return;
  }
  await delivery.save();
  throw new Error(delivery.attempts.at(-1)?.error || "Webhook delivery failed");
}

function recordAttempt(delivery: WebhookDeliveryDoc, attempt: { statusCode?: number; error: string; durationMs: number }) {
  delivery.attempts.push({ at: new Date(), statusCode: attempt.statusCode, error: attempt.error.slice(0, 300), durationMs: attempt.durationMs });
  delivery.markModified("attempts");
}

export async function repairWebhookDeliveries() {
  const pending = await WebhookDelivery.find({
    status: "pending",
    enqueued: false,
    createdAt: { $lt: new Date(Date.now() - 10_000) },
  }).limit(25);
  for (const delivery of pending) {
    try {
      await placeDelivery(delivery);
    } catch (error) {
      logger.error({ err: error, deliveryId: delivery.publicId }, "Webhook enqueue repair failed");
    }
  }
}

export type { WebhookDoc };
