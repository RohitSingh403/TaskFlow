import {
  ALERT_STATUSES,
  ALERT_TYPES,
  API_SCOPES,
  BACKOFF_TYPES,
  DEFAULT_JOB_SETTINGS,
  DEFAULT_MAX_WAITING,
  ENVIRONMENTS,
  JOB_STATUSES,
  LOG_RETENTION_SECONDS,
  PRIORITY_LABELS,
  WEBHOOK_EVENTS,
  type ApiScope,
  type BackoffType,
  type JobStatus,
  type PriorityLabel,
  type ProjectEnvironment,
} from "@taskflow/shared";
import mongoose, { type HydratedDocument, type InferSchemaType, Schema, type Types } from "mongoose";

const defaultJobSettingsSchema = new Schema(
  {
    maxAttempts: { type: Number, default: DEFAULT_JOB_SETTINGS.maxAttempts },
    backoffType: { type: String, enum: BACKOFF_TYPES, default: DEFAULT_JOB_SETTINGS.backoffType },
    backoffDelayMs: { type: Number, default: DEFAULT_JOB_SETTINGS.backoffDelayMs },
    timeoutMs: { type: Number, default: DEFAULT_JOB_SETTINGS.timeoutMs },
    priority: { type: String, enum: PRIORITY_LABELS, default: DEFAULT_JOB_SETTINGS.priority },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true, versionKey: false },
);

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    replacedByHash: { type: String },
    userAgent: { type: String },
    ip: { type: String },
  },
  { timestamps: true, versionKey: false },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const projectSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    environment: { type: String, enum: ENVIRONMENTS, required: true },
    plan: { type: String, enum: ["developer", "scale"], default: "developer" },
    jobRetentionDays: { type: Number, default: 30, min: 1, max: 365 },
    defaultJobSettings: { type: defaultJobSettingsSchema, default: () => ({ ...DEFAULT_JOB_SETTINGS }) },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

const queueSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    concurrency: { type: Number, required: true },
    maxWaiting: { type: Number, default: DEFAULT_MAX_WAITING },
    rateLimit: {
      type: new Schema(
        {
          max: { type: Number, required: true },
          duration: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    isPaused: { type: Boolean, default: false },
    bullQueueName: { type: String, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
queueSchema.index(
  { projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

const jobSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    queueId: { type: Schema.Types.ObjectId, ref: "QueueConfig", required: true },
    queuePublicId: { type: String, required: true },
    queueName: { type: String, required: true },
    bullQueueName: { type: String, required: true },
    name: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: JOB_STATUSES, required: true, index: true },
    priority: { type: String, enum: PRIORITY_LABELS, required: true },
    priorityValue: { type: Number, required: true },
    delayMs: { type: Number, default: 0 },
    timeoutMs: { type: Number, required: true },
    attemptsMade: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    backoffType: { type: String, enum: BACKOFF_TYPES, required: true },
    backoffDelayMs: { type: Number, required: true },
    allowSimulation: { type: Boolean, default: false },
    traceId: { type: String, required: true },
    idempotencyKey: { type: String },
    requestHash: { type: String },
    scheduleId: { type: String },
    workflowRunId: { type: String },
    workflowStepKey: { type: String },
    enqueued: { type: Boolean, default: false },
    result: { type: Schema.Types.Mixed },
    error: {
      type: new Schema(
        {
          message: { type: String, required: true },
          stack: { type: String },
          code: { type: String },
        },
        { _id: false },
      ),
    },
    createdBy: {
      type: new Schema(
        {
          type: { type: String, enum: ["user", "api_key", "system"], required: true },
          id: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    durationMs: { type: Number },
    removedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
jobSchema.index({ projectId: 1, createdAt: -1 });
jobSchema.index({ projectId: 1, status: 1, createdAt: -1 });
jobSchema.index({ projectId: 1, queueName: 1, createdAt: -1 });
jobSchema.index(
  { projectId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
jobSchema.index({ projectId: 1, scheduleId: 1, createdAt: -1 });
jobSchema.index({ workflowRunId: 1 });

const attemptSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "JobRecord", required: true },
    jobPublicId: { type: String, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    attemptNumber: { type: Number, required: true },
    workerId: { type: String },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    status: { type: String, enum: ["active", "completed", "failed"], required: true },
    errorMessage: { type: String },
    errorStack: { type: String },
  },
  { timestamps: true, versionKey: false },
);
attemptSchema.index({ jobId: 1, attemptNumber: 1 }, { unique: true });

const workerAssignmentSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    projectPublicId: { type: String, required: true },
    queuePublicId: { type: String, required: true },
    queueName: { type: String, required: true },
    bullQueueName: { type: String, required: true },
    concurrency: { type: Number, required: true },
  },
  { _id: false },
);

const workerSchema = new Schema(
  {
    workerId: { type: String, required: true, unique: true },
    hostname: { type: String, required: true },
    pid: { type: Number, required: true },
    assignments: { type: [workerAssignmentSchema], default: [] },
    activeJobs: { type: Number, default: 0 },
    activeJobIds: { type: [String], default: [] },
    jobsSucceeded: { type: Number, default: 0 },
    jobsFailed: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, required: true },
    startedAt: { type: Date, required: true },
    stoppedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
workerSchema.index({ "assignments.projectId": 1, lastHeartbeatAt: -1 });

const apiKeySchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true, select: false },
    scopes: { type: [String], enum: API_SCOPES, required: true },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

const logSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    level: { type: String, enum: ["debug", "info", "warn", "error"], required: true },
    message: { type: String, required: true },
    jobPublicId: { type: String },
    workerId: { type: String },
    traceId: { type: String },
    durationMs: { type: Number },
  },
  { versionKey: false },
);
logSchema.index({ projectId: 1, timestamp: -1 });
logSchema.index({ projectId: 1, jobPublicId: 1, timestamp: -1 });
logSchema.index({ timestamp: 1 }, { expireAfterSeconds: LOG_RETENTION_SECONDS });

const sideEffectSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    handler: { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

const scheduleSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    queueId: { type: Schema.Types.ObjectId, ref: "QueueConfig", required: true },
    queuePublicId: { type: String, required: true },
    queueName: { type: String, required: true },
    bullQueueName: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    handler: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    cron: { type: String, required: true },
    timeZone: { type: String, required: true },
    priority: { type: String, enum: PRIORITY_LABELS, required: true },
    priorityValue: { type: Number, required: true },
    timeoutMs: { type: Number, required: true },
    maxAttempts: { type: Number, required: true },
    backoffType: { type: String, enum: BACKOFF_TYPES, required: true },
    backoffDelayMs: { type: Number, required: true },
    paused: { type: Boolean, default: false },
    nextRunAt: { type: Date, required: true },
    lastRunAt: { type: Date },
    lastJobId: { type: String },
    lastError: { type: String },
    deletedAt: { type: Date },
    createdBy: {
      type: new Schema(
        {
          type: { type: String, enum: ["user", "api_key"], required: true },
          id: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
scheduleSchema.index(
  { projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
scheduleSchema.index({ paused: 1, deletedAt: 1, nextRunAt: 1 });

const workflowStepSchema = new Schema(
  {
    key: { type: String, required: true },
    handler: { type: String, required: true },
    queueName: { type: String, required: true },
    queuePublicId: { type: String, required: true },
    bullQueueName: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    dependsOn: { type: [String], default: [] },
  },
  { _id: false },
);

const workflowSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    steps: { type: [workflowStepSchema], required: true },
    deletedAt: { type: Date },
    createdBy: {
      type: new Schema(
        {
          type: { type: String, enum: ["user", "api_key"], required: true },
          id: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
workflowSchema.index(
  { projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

const workflowRunStepSchema = new Schema(
  {
    key: { type: String, required: true },
    handler: { type: String, required: true },
    queueName: { type: String, required: true },
    dependsOn: { type: [String], default: [] },
    jobId: { type: String, required: true },
  },
  { _id: false },
);

const workflowRunSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    workflowId: { type: Schema.Types.ObjectId, ref: "Workflow", required: true },
    workflowPublicId: { type: String, required: true },
    status: { type: String, enum: ["waiting", "active", "completed", "failed"], required: true },
    steps: { type: [workflowRunStepSchema], required: true },
    failedStepKey: { type: String },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    durationMs: { type: Number },
  },
  { timestamps: true, versionKey: false },
);
workflowRunSchema.index({ projectId: 1, createdAt: -1 });
workflowRunSchema.index({ workflowId: 1, createdAt: -1 });

const auditSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    actorType: { type: String, enum: ["user", "api_key", "system"], required: true },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

const alertRuleSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ALERT_TYPES, required: true },
    enabled: { type: Boolean, default: true },
    queueName: { type: String },
    threshold: { type: Number, default: 0 },
    windowMs: { type: Number },
    minSamples: { type: Number },
    cooldownMs: { type: Number, required: true },
    silencedUntil: { type: Date },
    lastTriggeredAt: { type: Date },
    lastError: { type: String, default: "" },
    deletedAt: { type: Date },
    createdBy: {
      type: new Schema(
        {
          type: { type: String, enum: ["user", "api_key"], required: true },
          id: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
alertRuleSchema.index(
  { projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
alertRuleSchema.index({ enabled: 1, deletedAt: 1 });

const alertEventSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    ruleId: { type: Schema.Types.ObjectId, ref: "AlertRule", required: true },
    rulePublicId: { type: String, required: true },
    type: { type: String, enum: ALERT_TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ALERT_STATUSES, required: true },
    resolvedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
alertEventSchema.index({ projectId: 1, createdAt: -1 });
alertEventSchema.index({ projectId: 1, status: 1, createdAt: -1 });

const webhookSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    url: { type: String, required: true },
    description: { type: String, default: "" },
    events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], required: true },
    secret: { type: String, required: true },
    secretPrefix: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    deletedAt: { type: Date },
    createdBy: {
      type: new Schema(
        {
          type: { type: String, enum: ["user", "api_key"], required: true },
          id: { type: String, required: true },
          label: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);
webhookSchema.index({ projectId: 1, enabled: 1, deletedAt: 1 });

const webhookAttemptSchema = new Schema(
  {
    at: { type: Date, required: true },
    statusCode: { type: Number },
    error: { type: String, default: "" },
    durationMs: { type: Number, required: true },
  },
  { _id: false },
);

const webhookDeliverySchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    webhookId: { type: Schema.Types.ObjectId, ref: "Webhook", required: true },
    webhookPublicId: { type: String, required: true },
    event: { type: String, enum: WEBHOOK_EVENTS, required: true },
    resourceId: { type: String, required: true },
    body: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["pending", "succeeded", "failed"], required: true },
    attempts: { type: [webhookAttemptSchema], default: [] },
    enqueued: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
webhookDeliverySchema.index({ webhookId: 1, event: 1, resourceId: 1 }, { unique: true });
webhookDeliverySchema.index({ projectId: 1, createdAt: -1 });
webhookDeliverySchema.index({ status: 1, enqueued: 1, createdAt: 1 });

const projectMemberSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    projectPublicId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userPublicId: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
projectMemberSchema.index(
  { projectId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
projectMemberSchema.index({ userId: 1, deletedAt: 1 });

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const RefreshToken = mongoose.models.RefreshToken || mongoose.model("RefreshToken", refreshTokenSchema);
export const Project = mongoose.models.Project || mongoose.model("Project", projectSchema);
export const QueueConfig = mongoose.models.QueueConfig || mongoose.model("QueueConfig", queueSchema);
export const JobRecord = mongoose.models.JobRecord || mongoose.model("JobRecord", jobSchema);
export const JobAttempt = mongoose.models.JobAttempt || mongoose.model("JobAttempt", attemptSchema);
export const WorkerRecord = mongoose.models.WorkerRecord || mongoose.model("WorkerRecord", workerSchema);
export const ApiKey = mongoose.models.ApiKey || mongoose.model("ApiKey", apiKeySchema);
export const LogEntry = mongoose.models.LogEntry || mongoose.model("LogEntry", logSchema);
export const SideEffect = mongoose.models.SideEffect || mongoose.model("SideEffect", sideEffectSchema);
export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", auditSchema);
export const Schedule = mongoose.models.Schedule || mongoose.model("Schedule", scheduleSchema);
export const Workflow = mongoose.models.Workflow || mongoose.model("Workflow", workflowSchema);
export const WorkflowRun = mongoose.models.WorkflowRun || mongoose.model("WorkflowRun", workflowRunSchema);
export const AlertRule = mongoose.models.AlertRule || mongoose.model("AlertRule", alertRuleSchema);
export const AlertEvent = mongoose.models.AlertEvent || mongoose.model("AlertEvent", alertEventSchema);
export const Webhook = mongoose.models.Webhook || mongoose.model("Webhook", webhookSchema);
export const WebhookDelivery = mongoose.models.WebhookDelivery || mongoose.model("WebhookDelivery", webhookDeliverySchema);
export const ProjectMember = mongoose.models.ProjectMember || mongoose.model("ProjectMember", projectMemberSchema);

export async function ensureIndexes() {
  await Promise.all(
    [User, RefreshToken, Project, QueueConfig, JobRecord, JobAttempt, WorkerRecord, ApiKey, LogEntry, SideEffect, Schedule, Workflow, WorkflowRun, AlertRule, AlertEvent, Webhook, WebhookDelivery, ProjectMember, AuditLog].map((model) =>
      model.syncIndexes(),
    ),
  );
}

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export type ProjectDoc = HydratedDocument<InferSchemaType<typeof projectSchema>>;
export type QueueDoc = HydratedDocument<InferSchemaType<typeof queueSchema>>;
export type JobDoc = HydratedDocument<InferSchemaType<typeof jobSchema>>;
export type ScheduleDoc = HydratedDocument<InferSchemaType<typeof scheduleSchema>>;
export type WorkflowDoc = HydratedDocument<InferSchemaType<typeof workflowSchema>>;
export type WorkflowRunDoc = HydratedDocument<InferSchemaType<typeof workflowRunSchema>>;
export type AlertRuleDoc = HydratedDocument<InferSchemaType<typeof alertRuleSchema>>;
export type AlertEventDoc = HydratedDocument<InferSchemaType<typeof alertEventSchema>>;
export type WebhookDoc = HydratedDocument<InferSchemaType<typeof webhookSchema>>;
export type WebhookDeliveryDoc = HydratedDocument<InferSchemaType<typeof webhookDeliverySchema>>;
export type ProjectMemberDoc = HydratedDocument<InferSchemaType<typeof projectMemberSchema>>;
export type ApiKeyDoc = HydratedDocument<InferSchemaType<typeof apiKeySchema>>;
export type WorkerDoc = HydratedDocument<InferSchemaType<typeof workerSchema>>;

export interface Actor {
  type: "user" | "api_key" | "system";
  id: string;
  label: string;
}

export type { ApiScope, BackoffType, JobStatus, PriorityLabel, ProjectEnvironment, Types };
