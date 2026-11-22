import { z } from "zod";
import {
  API_SCOPES,
  BACKOFF_TYPES,
  ENVIRONMENTS,
  PRIORITY_LABELS,
  QUEUE_NAME_PATTERN,
} from "./constants.js";
import { ALERT_STATUSES, BILLING_PLANS, DEFAULT_ALERT_COOLDOWN_MS, MAX_JOB_RETENTION_DAYS, MIN_JOB_RETENTION_DAYS, WEBHOOK_EVENTS } from "./constants.js";
import { isHandlerName } from "./handlers.js";
import { validateWorkflowGraph } from "./workflow.js";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(200),
  password: z
    .string()
    .min(10)
    .max(200)
    .regex(/[A-Za-z]/, "Password must include a letter")
    .regex(/[0-9]/, "Password must include a number"),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: registerSchema.shape.password,
});

export const projectSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(280).optional(),
  environment: z.enum(ENVIRONMENTS).default("development"),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(280).optional(),
    environment: z.enum(ENVIRONMENTS).optional(),
    jobRetentionDays: z.number().int().min(MIN_JOB_RETENTION_DAYS).max(MAX_JOB_RETENTION_DAYS).optional(),
    defaultJobSettings: z
      .object({
        maxAttempts: z.number().int().min(1).max(10),
        backoffType: z.enum(BACKOFF_TYPES),
        backoffDelayMs: z.number().int().min(0).max(86_400_000),
        timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000),
        priority: z.enum(PRIORITY_LABELS),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

export const queueSchema = z.object({
  name: z.string().trim().regex(QUEUE_NAME_PATTERN, "Use a lowercase queue name, such as emails or image-resize"),
  description: z.string().trim().max(280).optional(),
  concurrency: z.number().int().min(1).max(100).default(5),
  maxWaiting: z.number().int().min(1).max(100_000).default(10_000),
  rateLimit: z
    .object({
      max: z.number().int().min(1).max(10_000),
      duration: z.number().int().min(100).max(3_600_000),
    })
    .nullable()
    .optional(),
});

export const updateQueueSchema = z
  .object({
    description: z.string().trim().max(280).optional(),
    concurrency: z.number().int().min(1).max(100).optional(),
    maxWaiting: z.number().int().min(1).max(100_000).optional(),
    rateLimit: z
      .object({
        max: z.number().int().min(1).max(10_000),
        duration: z.number().int().min(100).max(3_600_000),
      })
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

export const submitJobSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN),
  name: z.string().trim().refine(isHandlerName, "Unknown job handler"),
  payload: z.record(z.unknown()),
  priority: z.enum(PRIORITY_LABELS).optional(),
  delayMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffType: z.enum(BACKOFF_TYPES).optional(),
  backoffDelayMs: z.number().int().min(0).max(86_400_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(280).optional(),
  scopes: z.array(z.enum(API_SCOPES)).min(1).default([...API_SCOPES]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const updateApiKeySchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(280).optional(),
    scopes: z.array(z.enum(API_SCOPES)).min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

export const retryFailedJobsSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const dismissFailedJobsSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const restoreDismissedJobsSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const cancelQueuedJobsSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const rescheduleJobSchema = z.object({
  delayMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
});

export const updateJobPrioritySchema = z.object({
  priority: z.enum(PRIORITY_LABELS),
});

export const moveJobSchema = z.object({
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN),
});

export const listJobsQuerySchema = z
  .object({
    status: z.enum(["waiting", "delayed", "active", "completed", "failed", "cancelled"]).optional(),
    queue: z.string().trim().max(80).optional(),
    priority: z.enum(PRIORITY_LABELS).optional(),
    name: z.string().trim().max(80).optional(),
    jobId: z.string().trim().max(80).optional(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
    schedule: z.string().trim().max(80).optional(),
    q: z.string().trim().max(120).optional(),
    dismissed: z.enum(["true", "false"]).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((query) => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to), {
    message: "The start of the window is after the end",
    path: ["from"],
  });

export const analyticsQuerySchema = z.object({
  range: z.enum(["24h", "7d", "30d"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const scheduleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(280).optional(),
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN),
  handler: z.string().trim().refine(isHandlerName, "Unknown job handler"),
  payload: z.record(z.unknown()),
  cron: z.string().trim().min(5).max(80),
  timeZone: z.string().trim().min(1).max(80).default("UTC"),
  priority: z.enum(PRIORITY_LABELS).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffType: z.enum(BACKOFF_TYPES).optional(),
  backoffDelayMs: z.number().int().min(0).max(86_400_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000).optional(),
});

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(280).optional(),
    queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
    handler: z.string().trim().refine(isHandlerName, "Unknown job handler").optional(),
    payload: z.record(z.unknown()).optional(),
    cron: z.string().trim().min(5).max(80).optional(),
    timeZone: z.string().trim().min(1).max(80).optional(),
    priority: z.enum(PRIORITY_LABELS).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    backoffType: z.enum(BACKOFF_TYPES).optional(),
    backoffDelayMs: z.number().int().min(0).max(86_400_000).optional(),
    timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

const workflowStepSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9-]{0,30}$/, "Use a lowercase step key, such as report or send-email"),
  handler: z.string().trim().refine(isHandlerName, "Unknown job handler"),
  queue: z.string().trim().regex(QUEUE_NAME_PATTERN),
  payload: z.record(z.unknown()),
  dependsOn: z.array(z.string().trim()).max(7).default([]),
});

export const workflowSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(280).optional(),
    steps: z.array(workflowStepSchema).min(2).max(8),
  })
  .superRefine((value, context) => {
    const graph = validateWorkflowGraph(value.steps);
    if (!graph.ok) context.addIssue({ code: z.ZodIssueCode.custom, message: graph.message, path: ["steps"] });
  });

export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(280).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

const alertName = z.string().trim().min(2).max(60);
const alertCooldown = z.number().int().min(60_000).max(24 * 60 * 60 * 1000).default(DEFAULT_ALERT_COOLDOWN_MS);

export const alertRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("queue.backlog"),
    name: alertName,
    queue: z.string().trim().regex(QUEUE_NAME_PATTERN),
    threshold: z.number().int().min(1).max(100_000),
    cooldownMs: alertCooldown,
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("failure.rate"),
    name: alertName,
    queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
    threshold: z.number().int().min(1).max(100),
    windowMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).default(15 * 60 * 1000),
    minSamples: z.number().int().min(1).max(1_000).default(5),
    cooldownMs: alertCooldown,
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("worker.offline"),
    name: alertName,
    cooldownMs: alertCooldown,
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("job.long_running"),
    name: alertName,
    queue: z.string().trim().regex(QUEUE_NAME_PATTERN).optional(),
    threshold: z.number().int().min(10_000).max(24 * 60 * 60 * 1000),
    cooldownMs: alertCooldown,
    enabled: z.boolean().default(true),
  }),
]);

export const updateAlertRuleSchema = z
  .object({
    name: alertName.optional(),
    enabled: z.boolean().optional(),
    threshold: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
    windowMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
    minSamples: z.number().int().min(1).max(1_000).optional(),
    cooldownMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

export const silenceAlertSchema = z.object({
  durationMs: z.number().int().min(5 * 60 * 1000).max(7 * 24 * 60 * 60 * 1000),
});

export const listAlertsQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const updateBillingSchema = z.object({
  plan: z.enum(BILLING_PLANS),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(200),
});

export const transferOwnershipSchema = z.object({
  memberId: z.string().trim().min(4).max(80),
});

export const webhookSchema = z.object({
  url: z.string().trim().url().max(500),
  description: z.string().trim().max(280).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

export const updateWebhookSchema = z
  .object({
    url: z.string().trim().url().max(500).optional(),
    description: z.string().trim().max(280).optional(),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No changes were provided" });

export const listLogsQuerySchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  jobId: z.string().trim().max(80).optional(),
  q: z.string().trim().max(160).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
