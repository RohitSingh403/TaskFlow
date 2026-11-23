import type { Job, JobAttempt, ListJobsQuery, PageMeta, Project, SubmitJobInput } from "./types.js";

export class TaskFlowError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TaskFlowError";
  }
}

export interface TaskFlowOptions {
  apiKey: string;
  baseUrl?: string;
  projectId?: string;
  fetch?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code?: string; message?: string; details?: { path: string; message: string }[] };
  meta?: PageMeta;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4000/api/v1";

export class TaskFlow {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly explicitProjectId?: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private resolvedProjectId: Promise<string> | null = null;

  constructor(options: TaskFlowOptions) {
    if (!options.apiKey) throw new TaskFlowError(0, "API_KEY_REQUIRED", "TaskFlow requires an API key");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.explicitProjectId = options.projectId;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 50;
  }

  async request<T>(method: string, path: string, init: { body?: unknown; query?: object; headers?: Record<string, string>; idempotent?: boolean } = {}): Promise<{ data: T; meta: PageMeta }> {
    const retryable = method === "GET" || init.idempotent === true;
    const attempts = retryable ? this.retries + 1 : 1;
    let lastError: TaskFlowError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.send<T>(method, path, init);
      } catch (error) {
        if (!(error instanceof TaskFlowError) || !isRetryable(error)) throw error;
        lastError = error;
        if (attempt === attempts) throw error;
        const backoff = Math.min(this.retryDelayMs * attempt, 1_000);
        await delay(Math.min(Math.max(backoff, error.retryAfterMs ?? 0), 2_000));
      }
    }
    throw lastError ?? new TaskFlowError(0, "REQUEST_FAILED", "Request failed");
  }

  private async send<T>(method: string, path: string, init: { body?: unknown; query?: object; headers?: Record<string, string> }): Promise<{ data: T; meta: PageMeta }> {
    const url = `${this.baseUrl}${path}${queryString(init.query)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      throw new TaskFlowError(0, "NETWORK_ERROR", error instanceof Error ? error.message : "The API could not be reached");
    }
    const text = await response.text();
    let body: Envelope<T> | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as Envelope<T>;
      } catch {
        throw new TaskFlowError(response.status, "INVALID_RESPONSE", "The API returned a response that was not JSON");
      }
    }
    if (!response.ok || body?.success === false) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined;
      throw new TaskFlowError(
        response.status,
        body?.error?.code || "REQUEST_FAILED",
        body?.error?.message || response.statusText || "Request failed",
        body?.error?.details,
        retryAfterMs,
      );
    }
    return { data: body?.data as T, meta: body?.meta ?? {} };
  }

  async projectId() {
    if (this.explicitProjectId) return this.explicitProjectId;
    this.resolvedProjectId ??= this.request<Project[]>("GET", "/projects")
      .then((result) => {
        const project = result.data[0];
        if (!project) throw new TaskFlowError(404, "PROJECT_NOT_FOUND", "This API key is not bound to a project");
        return project.id;
      })
      .catch((error: unknown) => {
        this.resolvedProjectId = null;
        throw error;
      });
    return this.resolvedProjectId;
  }

  async projectPath(suffix: string) {
    return `/projects/${await this.projectId()}${suffix}`;
  }

  readonly projects = {
    update: async (input: { name?: string; description?: string; environment?: "development" | "production"; jobRetentionDays?: number }) =>
      this.request<Project>("PATCH", await this.projectPath(""), { body: input }),
  };

  readonly jobs = {
    create: async (input: SubmitJobInput) => {
      const headers = input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : undefined;
      return this.request<Job>("POST", await this.projectPath("/jobs"), { body: input, headers, idempotent: Boolean(input.idempotencyKey) });
    },
    get: async (jobId: string) => this.request<Job>("GET", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}`)),
    wait: async (jobId: string, options: WaitOptions = {}) => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      const intervalMs = Math.max(50, options.intervalMs ?? 250);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await this.jobs.get(jobId);
        if (job.data.status === "completed" || job.data.status === "failed" || job.data.status === "cancelled") return job;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TaskFlowError(0, "JOB_WAIT_TIMEOUT", "The job did not finish before the wait timed out");
        await delay(Math.min(intervalMs, remaining));
      }
    },
    list: async (query: ListJobsQuery = {}) => this.request<Job[]>("GET", await this.projectPath("/jobs"), { query }),
    attempts: async (jobId: string) => this.request<JobAttempt[]>("GET", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/attempts`)),
    retry: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/retry`)),
    replay: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/replay`)),
    promote: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/promote`)),
    promoteDelayed: async (input: { queue?: string; limit?: number } = {}) =>
      this.request<{ promoted: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/promote-delayed"), { body: input }),
    reschedule: async (jobId: string, input: { delayMs: number }) =>
      this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/reschedule`), { body: input }),
    rescheduleQueued: async (input: { delayMs: number; queue?: string; limit?: number }) =>
      this.request<{ rescheduled: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/reschedule"), { body: input }),
    updatePriority: async (jobId: string, input: { priority: "high" | "medium" | "low" }) =>
      this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/priority`), { body: input }),
    updateQueuedPriority: async (input: { priority: "high" | "medium" | "low"; queue?: string; limit?: number }) =>
      this.request<{ updated: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/priority"), { body: input }),
    move: async (jobId: string, input: { queue: string }) =>
      this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/queue`), { body: input }),
    moveQueued: async (input: { queue: string; from?: string; limit?: number }) =>
      this.request<{ moved: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/move"), { body: input }),
    retryFailed: async (input: { queue?: string; limit?: number } = {}) =>
      this.request<{ retried: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/retry-failed"), { body: input }),
    dismissFailed: async (input: { queue?: string; limit?: number } = {}) =>
      this.request<{ dismissed: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/dismiss-failed"), { body: input }),
    restoreDismissed: async (input: { queue?: string; limit?: number } = {}) =>
      this.request<{ restored: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/restore-dismissed"), { body: input }),
    cancelQueued: async (input: { queue?: string; limit?: number } = {}) =>
      this.request<{ cancelled: number; skipped: number; jobIds: string[] }>("POST", await this.projectPath("/jobs/cancel-queued"), { body: input }),
    cancel: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/cancel`)),
    dismiss: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/dismiss`)),
    restore: async (jobId: string) => this.request<Job>("POST", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}/restore`)),
    delete: async (jobId: string) => this.request<Job>("DELETE", await this.projectPath(`/jobs/${encodeURIComponent(jobId)}`)),
  };

  readonly queues = {
    list: async () => this.request<QueueResource[]>("GET", await this.projectPath("/queues")),
    get: async (queueId: string) => this.request<QueueResource>("GET", await this.projectPath(`/queues/${encodeURIComponent(queueId)}`)),
    create: async (input: { name: string; description?: string; concurrency?: number; maxWaiting?: number }) =>
      this.request<QueueResource>("POST", await this.projectPath("/queues"), { body: input }),
    update: async (queueId: string, input: { description?: string; concurrency?: number; maxWaiting?: number; rateLimit?: { max: number; duration: number } | null }) =>
      this.request<QueueResource>("PATCH", await this.projectPath(`/queues/${encodeURIComponent(queueId)}`), { body: input }),
    pause: async (queueId: string) => this.request<QueueResource>("POST", await this.projectPath(`/queues/${encodeURIComponent(queueId)}/pause`)),
    resume: async (queueId: string) => this.request<QueueResource>("POST", await this.projectPath(`/queues/${encodeURIComponent(queueId)}/resume`)),
    delete: async (queueId: string) => this.request<{ id: string; deleted: boolean }>("DELETE", await this.projectPath(`/queues/${encodeURIComponent(queueId)}`)),
  };

  readonly schedules = {
    list: async () => this.request<ScheduleResource[]>("GET", await this.projectPath("/schedules")),
    get: async (scheduleId: string) => this.request<ScheduleResource>("GET", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}`)),
    create: async (input: Record<string, unknown>) => this.request<ScheduleResource>("POST", await this.projectPath("/schedules"), { body: input }),
    update: async (scheduleId: string, input: Record<string, unknown>) =>
      this.request<ScheduleResource>("PATCH", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}`), { body: input }),
    run: async (scheduleId: string) => this.request<Job>("POST", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}/run`)),
    pause: async (scheduleId: string) => this.request<ScheduleResource>("POST", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}/pause`)),
    pauseSchedules: async (input: { limit?: number } = {}) =>
      this.request<{ paused: number; scheduleIds: string[] }>("POST", await this.projectPath("/schedules/pause"), { body: input }),
    resumeSchedules: async (input: { limit?: number } = {}) =>
      this.request<{ resumed: number; scheduleIds: string[] }>("POST", await this.projectPath("/schedules/resume"), { body: input }),
    resume: async (scheduleId: string) => this.request<ScheduleResource>("POST", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}/resume`)),
    delete: async (scheduleId: string) => this.request<{ id: string; deleted: boolean }>("DELETE", await this.projectPath(`/schedules/${encodeURIComponent(scheduleId)}`)),
  };

  readonly workflows = {
    list: async () => this.request<WorkflowResource[]>("GET", await this.projectPath("/workflows")),
    get: async (workflowId: string) => this.request<WorkflowResource>("GET", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}`)),
    create: async (input: { name: string; description?: string; steps: Record<string, unknown>[] }) =>
      this.request<WorkflowResource>("POST", await this.projectPath("/workflows"), { body: input }),
    update: async (workflowId: string, input: { name?: string; description?: string; steps?: Record<string, unknown>[] }) =>
      this.request<WorkflowResource>("PATCH", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}`), { body: input }),
    pause: async (workflowId: string) => this.request<WorkflowResource>("POST", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/pause`)),
    resume: async (workflowId: string) => this.request<WorkflowResource>("POST", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/resume`)),
    delete: async (workflowId: string) => this.request<{ deleted: boolean }>("DELETE", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}`)),
    start: async (workflowId: string) => this.request<WorkflowRun>("POST", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/runs`)),
    cancel: async (workflowId: string, runId: string) =>
      this.request<WorkflowRun>("POST", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/cancel`)),
    runs: async (workflowId: string) => this.request<WorkflowRun[]>("GET", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/runs`)),
    run: async (workflowId: string, runId: string) =>
      this.request<WorkflowRun>("GET", await this.projectPath(`/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`)),
  };

  readonly alerts = {
    list: async (query: { status?: "open" | "resolved"; limit?: number } = {}) => this.request<AlertResource[]>("GET", await this.projectPath("/alerts"), { query }),
    resolve: async (alertId: string) => this.request<AlertResource>("POST", await this.projectPath(`/alerts/${encodeURIComponent(alertId)}/resolve`)),
    resolveOpen: async (input: { ruleId?: string; limit?: number } = {}) =>
      this.request<{ resolved: number; skipped: number; alertIds: string[] }>("POST", await this.projectPath("/alerts/resolve-open"), { body: input }),
    rules: {
      list: async () => this.request<AlertRule[]>("GET", await this.projectPath("/alerts/rules")),
      create: async (input: Record<string, unknown>) => this.request<AlertRule>("POST", await this.projectPath("/alerts/rules"), { body: input }),
      update: async (ruleId: string, input: Record<string, unknown>) =>
        this.request<AlertRule>("PATCH", await this.projectPath(`/alerts/rules/${encodeURIComponent(ruleId)}`), { body: input }),
      silence: async (ruleId: string, input: { durationMs: number }) =>
        this.request<AlertRule>("POST", await this.projectPath(`/alerts/rules/${encodeURIComponent(ruleId)}/silence`), { body: input }),
      unsilence: async (ruleId: string) =>
        this.request<AlertRule>("POST", await this.projectPath(`/alerts/rules/${encodeURIComponent(ruleId)}/unsilence`)),
      delete: async (ruleId: string) => this.request<{ deleted: boolean }>("DELETE", await this.projectPath(`/alerts/rules/${encodeURIComponent(ruleId)}`)),
    },
  };

  readonly webhooks = {
    list: async () => this.request<{ webhooks: WebhookEndpoint[]; deliveries: WebhookDelivery[] }>("GET", await this.projectPath("/webhooks")),
    create: async (input: { url: string; description?: string; events: string[] }) =>
      this.request<WebhookEndpoint & { secret: string }>("POST", await this.projectPath("/webhooks"), { body: input }),
    update: async (webhookId: string, input: { url?: string; description?: string; events?: string[]; enabled?: boolean }) =>
      this.request<WebhookEndpoint>("PATCH", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}`), { body: input }),
    rotate: async (webhookId: string) => this.request<WebhookEndpoint & { secret: string }>("POST", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}/rotate`)),
    test: async (webhookId: string) => this.request<WebhookDelivery>("POST", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}/test`)),
    delete: async (webhookId: string) => this.request<{ deleted: boolean }>("DELETE", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}`)),
    deliveries: async (webhookId: string) => this.request<WebhookDelivery[]>("GET", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}/deliveries`)),
    redeliver: async (webhookId: string, deliveryId: string) =>
      this.request<WebhookDelivery>("POST", await this.projectPath(`/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`)),
    redeliverFailed: async (input: { webhookId?: string; limit?: number } = {}) =>
      this.request<{ redelivered: number; skipped: number; deliveryIds: string[] }>("POST", await this.projectPath("/webhooks/redeliver-failed"), { body: input }),
  };

  readonly billing = {
    get: async () => this.request<BillingResource>("GET", await this.projectPath("/billing")),
    update: async (input: { plan: "developer" | "scale" }) => this.request<BillingResource>("PATCH", await this.projectPath("/billing"), { body: input }),
  };

  readonly members = {
    list: async () => this.request<{ role: "owner" | "member"; members: ProjectMemberResource[] }>("GET", await this.projectPath("/members")),
    invite: async (input: { email: string }) => this.request<ProjectMemberResource>("POST", await this.projectPath("/members"), { body: input }),
    remove: async (memberId: string) => this.request<{ deleted: boolean }>("DELETE", await this.projectPath(`/members/${encodeURIComponent(memberId)}`)),
    leave: async () => this.request<{ left: boolean }>("POST", await this.projectPath("/members/leave")),
    transfer: async (input: { memberId: string }) =>
      this.request<{ ownerId: string; previousOwnerId: string }>("POST", await this.projectPath("/members/transfer"), { body: input }),
  };

  readonly workers = {
    list: async () => this.request<WorkerResource[]>("GET", await this.projectPath("/workers")),
    get: async (workerId: string) => this.request<WorkerResource>("GET", await this.projectPath(`/workers/${encodeURIComponent(workerId)}`)),
    jobs: async (workerId: string) => this.request<unknown[]>("GET", await this.projectPath(`/workers/${encodeURIComponent(workerId)}/jobs`)),
  };

  readonly logs = {
    list: async (query: object = {}) => this.request<LogResource[]>("GET", await this.projectPath("/logs"), { query }),
  };

  readonly analytics = {
    overview: async (query: object = {}) => this.request<Record<string, unknown>>("GET", await this.projectPath("/analytics/overview"), { query }),
    throughput: async (query: object = {}) => this.request<Record<string, unknown>>("GET", await this.projectPath("/analytics/throughput"), { query }),
    latency: async (query: object = {}) => this.request<Record<string, unknown>>("GET", await this.projectPath("/analytics/latency"), { query }),
    failures: async (query: object = {}) => this.request<Record<string, unknown>>("GET", await this.projectPath("/analytics/failures"), { query }),
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryable(error: TaskFlowError) {
  return error.code === "NETWORK_ERROR" || RETRYABLE_STATUS.has(error.status);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function queryString(query?: object) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

interface QueueResource {
  id: string;
  name: string;
  concurrency: number;
  isPaused: boolean;
  status: string;
}

interface ScheduleResource {
  id: string;
  name: string;
  queue: string;
  cron: string;
  timeZone: string;
  paused: boolean;
  status: string;
  nextRunAt: string | null;
}

interface WorkflowResource {
  id: string;
  name: string;
  description: string;
  paused: boolean;
}

interface WorkflowRun {
  id: string;
  status: string;
}

interface AlertResource {
  id: string;
  type: string;
  title: string;
  status: string;
}

interface AlertRule {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  threshold: number;
  cooldownMs: number;
  silencedUntil: string | null;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretPrefix: string;
}

interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  resourceId: string;
}

interface BillingResource {
  plan: "developer" | "scale";
  allowance: number;
  used: number;
  periodStart: string;
  periodEnd: string;
}

interface ProjectMemberResource {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "member";
}

interface WorkerResource {
  id: string;
  health: string;
}

interface LogResource {
  id: string;
  level: string;
  message: string;
  jobId: string | null;
}
