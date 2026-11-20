export interface PageMeta {
  requestId?: string;
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  environment: "development" | "production";
  jobRetentionDays?: number;
  createdAt?: string;
}

export interface Job {
  id: string;
  queueId: string;
  queue: string;
  name: string;
  status: "waiting" | "delayed" | "active" | "completed" | "failed" | "cancelled";
  priority: "high" | "medium" | "low";
  payload: Record<string, unknown>;
  attemptsMade: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  result: unknown;
  error: { message: string; stack: string | null; code: string | null } | null;
  createdAt?: string;
  completedAt: string | null;
  durationMs: number | null;
  duplicate?: boolean;
}

export interface JobAttempt {
  attemptNumber: number;
  workerId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

export interface SubmitJobInput {
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  priority?: "high" | "medium" | "low";
  delayMs?: number;
  maxAttempts?: number;
  backoffType?: "exponential" | "fixed";
  backoffDelayMs?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ListJobsQuery {
  status?: Job["status"];
  queue?: string;
  priority?: Job["priority"];
  name?: string;
  jobId?: string;
  q?: string;
  page?: number;
  limit?: number;
}
