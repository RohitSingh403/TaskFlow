export const API_PREFIX = "/api/v1";
export const EVENTS_CHANNEL = "taskflow:events";

export const HEARTBEAT_ONLINE_MS = 15_000;
export const HEARTBEAT_UNHEALTHY_MS = 45_000;

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MAX_WAITING = 10_000;
export const MAX_SCHEDULES_PER_PROJECT = 50;
export const SCHEDULE_MISSED_GRACE_MS = 60_000;
export const LOG_RETENTION_SECONDS = 14 * 24 * 60 * 60;
export const PERCENTILE_SAMPLE_LIMIT = 5_000;

export const JOB_STATUSES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const PRIORITY_LABELS = ["high", "medium", "low"] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

export const BACKOFF_TYPES = ["exponential", "fixed"] as const;
export type BackoffType = (typeof BACKOFF_TYPES)[number];

export const ENVIRONMENTS = ["development", "production"] as const;
export type ProjectEnvironment = (typeof ENVIRONMENTS)[number];

export const API_SCOPES = [
  "jobs:read",
  "jobs:write",
  "queues:read",
  "queues:write",
  "workers:read",
  "logs:read",
  "analytics:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const DEFAULT_JOB_SETTINGS = {
  maxAttempts: 3,
  backoffType: "exponential" as BackoffType,
  backoffDelayMs: 5_000,
  timeoutMs: 30_000,
  priority: "medium" as PriorityLabel,
};

export const DEFAULT_QUEUES = [
  {
    name: "emails",
    description: "Transactional and lifecycle email",
    concurrency: 5,
  },
  {
    name: "reports",
    description: "Generated reports and exports",
    concurrency: 2,
  },
  {
    name: "notifications",
    description: "In-app and push notifications",
    concurrency: 10,
  },
] as const;

export const QUEUE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
