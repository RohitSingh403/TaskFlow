export interface User {
  id: string;
  name: string;
  email: string;
  createdAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  environment: "development" | "production";
  defaultJobSettings: {
    maxAttempts: number;
    backoffType: "exponential" | "fixed";
    backoffDelayMs: number;
    timeoutMs: number;
    priority: "high" | "medium" | "low";
  };
  createdAt?: string;
  usage?: { queues: number; jobs: number; failedJobs: number; activeKeys: number };
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface Queue {
  id: string;
  name: string;
  description: string;
  concurrency: number;
  maxWaiting: number;
  rateLimit: { max: number; duration: number } | null;
  isPaused: boolean;
  status: "running" | "paused";
  createdAt?: string;
  stats?: QueueStats;
}

export type JobStatus = "waiting" | "delayed" | "active" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  queueId: string;
  queue: string;
  name: string;
  status: JobStatus;
  priority: "high" | "medium" | "low";
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  attemptsMade: number;
  maxAttempts: number;
  backoffType: "exponential" | "fixed";
  backoffDelayMs: number;
  delayMs: number;
  timeoutMs: number;
  traceId: string;
  idempotencyKey: string | null;
  result: unknown;
  error: { message: string; stack: string | null; code: string | null } | null;
  createdBy: { type: string; id: string; label: string };
  enqueued: boolean;
  createdAt?: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  duplicate?: boolean;
}

export interface Attempt {
  attemptNumber: number;
  workerId: string | null;
  status: "active" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface Worker {
  id: string;
  hostname: string;
  pid: number;
  health: "online" | "unhealthy" | "offline";
  queues: { id: string; name: string; concurrency: number }[];
  concurrency: number;
  activeJobs: number;
  activeJobIds: string[];
  jobsSucceeded: number;
  jobsFailed: number;
  lastHeartbeatAt: string;
  startedAt: string;
  stoppedAt: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  description: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt?: string;
  status: "active" | "revoked";
  secret?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  jobId: string | null;
  workerId: string | null;
  traceId: string | null;
  durationMs: number | null;
}

export interface Overview {
  range: { from: string; to: string };
  totals: {
    submitted: number;
    completed: number;
    failed: number;
    waiting: number;
    active: number;
    cancelled: number;
    failureRate: number;
  };
  latency: { count: number; avg: number | null; p50: number | null; p95: number | null; p99: number | null };
  live: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  workers: {
    total: number;
    online: number;
    unhealthy: number;
    items: { id: string; health: Worker["health"]; activeJobs: number; hostname: string }[];
  };
  queues: (QueueStats & { id: string; name: string; status: string; concurrency: number })[];
  recentFailures: { id: string; name: string; queue: string; message: string; attempts: string; completedAt: string | null }[];
}

export interface Throughput {
  bucket: { unit: string; binSize: number };
  points: { at: string; total: number; completed: number; failed: number }[];
}

export interface HandlerInfo {
  name: string;
  title: string;
  description: string;
  suggestedQueue: string;
  example: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actorId: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

export interface PageMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  requestId?: string;
}
