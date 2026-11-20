# HTTP API

Base path: `/api/v1`.

## Response

```json
{ "success": true, "data": {}, "meta": { "requestId": "req_..." } }
```

```json
{
  "success": false,
  "error": { "code": "JOB_NOT_FOUND", "message": "The requested job was not found." },
  "meta": { "requestId": "req_..." }
}
```

Validation errors include `error.details[]` with `path` and `message`. Unexpected failures return `INTERNAL_ERROR` and do not include a stack. Handler failures are different: the project owner can read `error.stack` on the job, because that is the execution record.

## Auth

`Authorization: Bearer <access token>` or `Authorization: Bearer tf_live_...`.

Refresh tokens are `HttpOnly` cookies on `/api/v1/auth`, `SameSite=Lax`. The raw token is not stored. Reuse of a revoked refresh token revokes the user's outstanding refresh tokens. A duplicate presentation within 15 seconds of a rotation is rejected without revoking the replacement, and concurrent refreshes of the same token in one API process share a single rotation. This keeps a retried refresh, including React's development double-render, from signing the user out.

API key scopes: `jobs:read`, `jobs:write`, `queues:read`, `queues:write`, `workers:read`, `logs:read`, `analytics:read`. Creating keys, projects, and profile changes requires a user session.

## Jobs

`POST /projects/:projectId/jobs`

```json
{
  "queue": "emails",
  "name": "send-email",
  "payload": { "to": "user@example.com", "subject": "Welcome", "body": "Hello" },
  "priority": "high",
  "delayMs": 0,
  "maxAttempts": 3,
  "backoffType": "exponential",
  "backoffDelayMs": 5000,
  "timeoutMs": 30000,
  "idempotencyKey": "welcome-user-123"
}
```

`Idempotency-Key` header overrides the body field. Lists accept `status`, `queue`, `priority`, `name`, `jobId`, `q`, `from`, `to`, `page`, and `limit` (max 100).

A job that has used its attempts stays `failed` on the same queue. `POST /projects/:projectId/jobs/retry-failed` with `{ "queue": "emails", "limit": 20 }` retries the oldest failed jobs, up to 50. The same job id is queued again. A repeated call does not insert another job record.

`_simulate` is allowed only when the project environment is `development`:

```json
{ "_simulate": { "failUntilAttempt": 1, "delayMs": 200, "errorMessage": "Provider timed out" } }
```

## Schedules

`POST /projects/:projectId/schedules`

```json
{
  "name": "Morning report",
  "queue": "reports",
  "handler": "generate-report",
  "cron": "0 9 * * *",
  "timeZone": "Asia/Kolkata",
  "payload": { "reportType": "sales", "format": "pdf", "rangeDays": 7 }
}
```

`cron` is five fields: minute, hour, day of month, month, weekday. `POST /pause` stops future occurrences. `POST /resume` moves `nextRunAt` forward when the stored time is already past, so a resume does not fire a missed tick immediately. Deleting a schedule is soft. Jobs already created keep running.

The scheduler process is the only producer. If it is down for more than a minute, missed ticks are skipped.

## Workflows

`POST /projects/:projectId/workflows`

```json
{
  "name": "Report then email",
  "steps": [
    {
      "key": "report",
      "handler": "generate-report",
      "queue": "reports",
      "dependsOn": [],
      "payload": { "reportType": "activity", "format": "pdf", "rangeDays": 7 }
    },
    {
      "key": "email",
      "handler": "send-email",
      "queue": "emails",
      "dependsOn": ["report"],
      "payload": { "to": "ops@example.com", "subject": "Activity report", "body": "The activity report is ready." }
    }
  ]
}
```

A workflow has 2 to 8 steps and exactly one final step. A step may wait for several earlier steps. An earlier step can be a dependency of only one later step, because BullMQ flows are trees. Cycles are rejected.

`POST /projects/:projectId/workflows/:workflowId/runs` creates one job per step and submits them together. The email stays waiting until the report completes. If the report fails and has no attempts left, the email does not run. `POST /projects/:projectId/jobs/:jobId/retry` on that failed job lets the rest of the tree continue. Name and description can change after creation. The step list cannot. Deleting a workflow is soft.

## Alerts

`POST /projects/:projectId/alerts/rules`

```json
{ "type": "queue.backlog", "name": "Email backlog", "queue": "emails", "threshold": 100 }
```

`type` is `queue.backlog`, `failure.rate`, `worker.offline`, or `job.long_running`. A failure-rate rule uses `threshold` as a percent and skips until `minSamples` jobs have finished in `windowMs`. A long-running rule uses `threshold` as milliseconds a job has stayed active. `cooldownMs` defaults to 15 minutes.

The scheduler leader evaluates enabled rules. A true rule opens one alert, then waits out the cooldown before it can open another. `GET /projects/:projectId/alerts` is the history. `POST /projects/:projectId/alerts/:alertId/resolve` marks one resolved. Deleting a rule is soft and stops future checks.

## Webhooks

`POST /projects/:projectId/webhooks`

```json
{ "url": "https://example.com/taskflow", "description": "Ops", "events": ["job.completed", "job.failed"] }
```

The create and rotate responses include `secret` once. Later reads return `secretPrefix` only. The secret is `whsec_` plus random data, and it is stored so deliveries can be signed. Production projects accept `https` URLs that do not resolve to a private, loopback, or link-local address. A development project may also use `http://127.0.0.1` or `http://localhost`.

TaskFlow POSTs the same JSON body on every attempt. Headers are `TaskFlow-Delivery`, `TaskFlow-Event`, `TaskFlow-Timestamp`, and `TaskFlow-Signature` (`t=<unix>,v1=<hex>`). The signature is HMAC-SHA256 of `<timestamp>.<raw body>` using the current secret. A receiver should treat the delivery id as its dedupe key. Redirects are not followed. A non-2xx response is retried up to five times. A project can keep 10 endpoints.

## Queues

`POST /projects/:projectId/queues/:queueId/pause` and `/resume`.

`PATCH` accepts `description`, `concurrency` (1–100), `maxWaiting`, and `rateLimit` (`{ max, duration }` or `null`). `rateLimit.duration` is a window in milliseconds. Concurrency is simultaneous work. The rate limit is admissions per window.

## Analytics

`GET /projects/:projectId/analytics/overview?range=24h|7d|30d`

Live waiting and active counts come from BullMQ. Submitted, completed, and failed totals in the window come from MongoDB. Latency percentiles are computed in process from up to 5,000 completed durations.

## Members

`POST /projects/:projectId/members`

```json
{ "email": "grace@example.com" }
```

The email must already belong to an account. TaskFlow does not send an invitation message. The owner can add 20 members. A member can submit and inspect work. Changing settings, managing API keys, inviting people, and deleting the project stay with the owner. `POST /projects/:projectId/members/transfer` with `{ "memberId": "mem_..." }` makes that member the owner and keeps the previous owner as a member. API keys stay with the project. `POST /projects/:projectId/members/leave` removes the signed-in member. The owner cannot leave. An account that cannot see the project still receives `404`.

## Billing

`GET /projects/:projectId/billing` returns the plan, the number of jobs created since the start of the current UTC month, and the allowance. `developer` allows 2,000 jobs. `scale` allows 50,000. `PATCH` with `{ "plan": "scale" }` is owner-only.

A new job, workflow run, or scheduled tick that would pass the allowance is rejected. Replaying an idempotency key does not count again. No card is charged.

## Client

`@taskflow/sdk` is a thin TypeScript client. Pass an API key and, when the API is not on `http://127.0.0.1:4000`, a `baseUrl`. The key is bound to one project, so the client reads that project on the first call. `jobs.create` returns when the API accepts the job. It does not wait for a worker, and it does not retry. Pass `idempotencyKey` when a retry of that call must return the original job.
