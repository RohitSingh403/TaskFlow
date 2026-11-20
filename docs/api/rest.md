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

## Queues

`POST /projects/:projectId/queues/:queueId/pause` and `/resume`.

`PATCH` accepts `description`, `concurrency` (1–100), `maxWaiting`, and `rateLimit` (`{ max, duration }` or `null`). `rateLimit.duration` is a window in milliseconds. Concurrency is simultaneous work. The rate limit is admissions per window.

## Analytics

`GET /projects/:projectId/analytics/overview?range=24h|7d|30d`

Live waiting and active counts come from BullMQ. Submitted, completed, and failed totals in the window come from MongoDB. Latency percentiles are computed in process from up to 5,000 completed durations.
