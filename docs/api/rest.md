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

API key scopes: `jobs:read`, `jobs:write`, `queues:read`, `queues:write`, `workers:read`, `logs:read`, `analytics:read`. Creating keys, projects, and profile changes requires a user session. `POST /projects/:projectId/api-keys` accepts `expiresInDays` from 1 to 365. Leave it out and the key stays valid until it is revoked. An expired key returns `401` `API_KEY_EXPIRED`. Revoking a key still returns `401` `UNAUTHORIZED`.

`PATCH /projects/:projectId/api-keys/:keyId` changes the name, description, scopes, or expiry. The key id, prefix, and hash stay, so callers keep the same secret. `scopes` replaces the whole list. Duplicate entries are stored once, in the platform's scope order. An empty list or an unknown scope returns `400` `VALIDATION_ERROR`. `expiresInDays` from 1 to 365 sets `expiresAt` from now. `null` clears it, so the key stays valid until it is revoked. A value outside 1 to 365 returns `400` `VALIDATION_ERROR`. A name shorter than 2 characters returns the same code. An expired key can be extended, and the same secret works again. A revoked key returns `409` `API_KEY_REVOKED`. A member receives `403` `OWNER_REQUIRED`.

## Projects

`PATCH /projects/:projectId` accepts `jobRetentionDays`, from 1 to 365. The default is 30. The scheduler deletes finished, failed, and cancelled jobs, and a finished workflow run, once every record in that set is older than the window. Waiting and active jobs stay. A repeated idempotency key can create a new job after the original record is gone. Only the owner can change the setting.

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

`Idempotency-Key` header overrides the body field. Lists accept `status`, `queue`, `priority`, `name`, `jobId`, `idempotencyKey`, `q`, `from`, `to`, `page`, and `limit` (max 100). `idempotencyKey` is an exact match and returns the one job that used that key, or an empty list. A key shorter than 8 characters or longer than 200 returns `400` `VALIDATION_ERROR`. `from` and `to` are ISO datetimes on `createdAt`. Leave either one out to leave that side open. A `from` later than `to` returns `400` `VALIDATION_ERROR`.

A job that has used its attempts stays `failed` on the same queue. `POST /projects/:projectId/jobs/retry-failed` with `{ "queue": "emails", "limit": 20 }` retries the oldest failed jobs that are still on the dead letter list, up to 50. The same job id is queued again. A repeated call does not insert another job record. A dismissed job is skipped.

`POST /projects/:projectId/jobs/dismiss-failed` with `{ "queue": "emails", "limit": 20 }` sets `dismissedAt` on the oldest failed jobs that are still listed, up to 50. The status stays `failed` and the job id stays. A waiting job is left alone. A second call does not dismiss those jobs again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/jobs/restore-dismissed` with `{ "queue": "emails", "limit": 20 }` clears `dismissedAt` on the oldest dismissed jobs, up to 50. The status stays `failed` and the job id stays, so the job returns to the open dead letter list. A job that is still listed is left alone. A second call does not restore those jobs again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/jobs/:jobId/dismiss` sets `dismissedAt` on a failed job. The status stays `failed`, and `GET /jobs?status=failed&dismissed=false` no longer returns it. A waiting, delayed, active, completed, or cancelled job returns `409` `JOB_NOT_DISMISSIBLE`. A second dismiss returns the same code. `POST /projects/:projectId/jobs/:jobId/restore` clears `dismissedAt`. Restoring a job that is still listed returns `409` `JOB_NOT_DISMISSIBLE`. Retrying that job clears the dismissal, so a later failure can return to the list.

Lists also accept `dismissed=true` or `dismissed=false`. Omitting it returns both.

`POST /projects/:projectId/jobs/cancel-queued` with the same shape cancels the oldest waiting and delayed jobs, up to 50. Active jobs are skipped. A job that belongs to a workflow run is left alone, because cancelling one step from this list would leave the run without that step. Repeat the call when more than 50 jobs are queued.

`POST /projects/:projectId/jobs/:jobId/replay` queues a new job with the same handler, payload, queue, priority, attempts, backoff, and timeout. The copy waits immediately, even when the original was delayed. It does not keep the idempotency key, schedule, or workflow run. The original job is unchanged. The copy counts toward the monthly allowance, and the queue waiting ceiling still applies. A second call creates another job.

`POST /projects/:projectId/jobs/:jobId/promote` runs a delayed job now. The same job id moves from delayed to waiting, and its delay becomes 0. The idempotency key, schedule, and workflow run stay on that job. This does not count toward the monthly allowance. A waiting, active, completed, failed, or cancelled job returns `409` `JOB_NOT_DELAYED`. A second call returns the same code, because the job is no longer delayed.

`POST /projects/:projectId/jobs/promote-delayed` with `{ "queue": "emails", "limit": 20 }` runs the oldest delayed jobs now, up to 50. Each job keeps its id, and its delay becomes 0. A waiting or active job is left alone. A second call does not run those jobs again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`. This does not count toward the monthly allowance.

`POST /projects/:projectId/jobs/:jobId/reschedule` with `{ "delayMs": 60000 }` sets a new delay on a waiting or delayed job. The delay is measured from now and can be 0 through 30 days. The same job id stays, along with its idempotency key, schedule, and workflow run. This does not count toward the monthly allowance. `delayMs: 0` clears the delay. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`. A workflow step that is already waiting returns `409` `WORKFLOW_JOB`, because moving it would leave its run. A delayed workflow step can still take a new delay.

`POST /projects/:projectId/jobs/reschedule` with `{ "queue": "emails", "delayMs": 60000, "limit": 20 }` gives that delay to the oldest waiting and delayed jobs, up to 50. Each job keeps its id. The delay is measured from the call, so a later call starts the wait again. `delayMs: 0` clears the delay. A waiting workflow step is skipped. An active job is left alone. An unknown queue returns `404` `QUEUE_NOT_FOUND`. A delay outside 0 to 30 days, or a limit outside 1 to 50, returns `400` `VALIDATION_ERROR`. This does not count toward the monthly allowance.

`POST /projects/:projectId/jobs/:jobId/priority` with `{ "priority": "high" }` changes the priority of a waiting or delayed job. `high`, `medium`, and `low` are the same labels used at submission. The same job id stays, along with its delay, idempotency key, schedule, and workflow run. This does not count toward the monthly allowance. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`. Sending the priority the job already has leaves that job as it is.

`POST /projects/:projectId/jobs/priority` with `{ "queue": "emails", "priority": "high", "limit": 20 }` changes the oldest waiting and delayed jobs that do not already have that priority, up to 50. Each job keeps its id, delay, and idempotency key. An active job is left alone. A second call does not change those jobs again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. An unknown priority or a limit outside 1 to 50 returns `400` `VALIDATION_ERROR`. This does not count toward the monthly allowance.

`POST /projects/:projectId/jobs/:jobId/queue` with `{ "queue": "reports" }` moves a waiting or delayed job onto another queue in the same project. The same job id stays, along with its delay, priority, idempotency key, and schedule. This does not count toward the monthly allowance. The destination queue's waiting ceiling still applies and returns `429` `QUEUE_BACKPRESSURE` when it is full; the job stays on its current queue. Naming the queue the job is already on leaves that job as it is. A workflow step returns `409` `WORKFLOW_JOB`. An unknown queue returns `404` `QUEUE_NOT_FOUND`. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`.

`POST /projects/:projectId/jobs/move` with `{ "queue": "reports", "from": "emails", "limit": 20 }` moves the oldest waiting and delayed jobs onto that queue, up to 50. Each job keeps its id, delay, priority, and idempotency key. Leave `from` out to include every other queue. A workflow step stays on its queue. A job already on the destination is left alone. A second call does not move those jobs again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. Naming the same queue in `queue` and `from`, or a limit outside 1 to 50, returns `400` `VALIDATION_ERROR`. A full destination returns `429` `QUEUE_BACKPRESSURE`. This does not count toward the monthly allowance.

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

`cron` is five fields: minute, hour, day of month, month, weekday. `PATCH /projects/:projectId/schedules/:scheduleId` changes the schedule in place. The id, pause state, and jobs already created stay. A new `cron` or `timeZone` recalculates `nextRunAt` from the current time. An invalid pattern or time zone returns `400` `INVALID_SCHEDULE`. An empty body returns `400` `VALIDATION_ERROR`. `POST /pause` stops future occurrences. `POST /resume` moves `nextRunAt` forward when the stored time is already past, so a resume does not fire a missed tick immediately. Deleting a schedule is soft. Jobs already created keep running.

`POST /projects/:projectId/schedules/pause` with `{ "limit": 20 }` pauses the oldest running schedules, up to 50. Each schedule keeps its id and its `nextRunAt`. A schedule that is already paused is left alone, and so is a deleted schedule. A second call returns `paused: 0`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/schedules/resume` with `{ "limit": 20 }` resumes the oldest paused schedules, up to 50. Each schedule keeps its id. `nextRunAt` stays when it is still in the future, and moves forward when it is already past, using the same rule as a single resume. A schedule that is already running is left alone, and so is a deleted schedule. A second call returns `resumed: 0`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/schedules/:scheduleId/run` queues one job immediately. It does not change `nextRunAt`. A paused schedule can still be run. The job counts toward the monthly allowance. A second call creates another job. If the scheduler is down for more than a minute, missed cron ticks are still skipped.

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

`PATCH /projects/:projectId/workflows/:workflowId` changes the name, description, or steps in place. The workflow id and pause state stay. `steps` replaces the whole tree. The next run uses that tree. A run that already started keeps the steps and job ids it began with. A list shorter than 2 steps, longer than 8, or not a tree returns `400` `VALIDATION_ERROR`. An unknown queue returns `404` `QUEUE_NOT_FOUND`. A name shorter than 2 characters, or an empty body, returns `400` `VALIDATION_ERROR`. A duplicate name returns `409` `WORKFLOW_EXISTS`.

`POST /projects/:projectId/workflows/:workflowId/pause` stops new runs. The workflow id, steps, and runs that already started stay. A second pause returns `409` `WORKFLOW_PAUSED`. Starting a run while the workflow is paused returns the same code. `POST /projects/:projectId/workflows/:workflowId/resume` accepts runs again. Resuming a workflow that is not paused returns `409` `WORKFLOW_NOT_PAUSED`.

`POST /projects/:projectId/workflows/pause` with `{ "limit": 20 }` pauses the oldest running workflows, up to 50. Each workflow keeps its id, its steps, and any run that already started. A workflow that is already paused is left alone, and so is a deleted workflow. A second call returns `paused: 0`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/workflows/resume` with `{ "limit": 20 }` resumes the oldest paused workflows, up to 50. Each workflow keeps its id, its steps, and any run that already started. A new run can start again. A workflow that is already running is left alone, and so is a deleted workflow. A second call returns `resumed: 0`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

`POST /projects/:projectId/workflows/:workflowId/runs` creates one job per step and submits them together. The email stays waiting until the report completes. If the report fails and has no attempts left, the email does not run. `POST /projects/:projectId/jobs/:jobId/retry` on that failed job lets the rest of the tree continue. Deleting a workflow is soft.

`POST /projects/:projectId/workflows/:workflowId/runs/:runId/cancel` removes every waiting or delayed step and marks the run `cancelled`. Completed and failed steps stay on the same run id. An active step returns `409` `WORKFLOW_RUN_NOT_CANCELLABLE`. A run that has already finished or is already cancelled returns the same code. A later update does not move a cancelled run back to waiting, active, completed, or failed.

## Alerts

`POST /projects/:projectId/alerts/rules`

```json
{ "type": "queue.backlog", "name": "Email backlog", "queue": "emails", "threshold": 100 }
```

`type` is `queue.backlog`, `failure.rate`, `worker.offline`, or `job.long_running`. A failure-rate rule uses `threshold` as a percent and skips until `minSamples` jobs have finished in `windowMs`. A long-running rule uses `threshold` as milliseconds a job has stayed active. `cooldownMs` defaults to 15 minutes.

`PATCH /projects/:projectId/alerts/rules/:ruleId` changes the name, threshold, window, sample minimum, or cooldown in place. The rule id, type, queue, and silence stay. An offline-worker rule has no threshold and returns `400` `VALIDATION_ERROR` if one is sent. A failure-rate threshold above 100, or a long-running threshold under 10 seconds, returns the same code. A duplicate name returns `409` `ALERT_EXISTS`.

The scheduler leader evaluates enabled rules. A true rule opens one alert, then waits out the cooldown before it can open another. `POST /projects/:projectId/alerts/rules/:ruleId/silence` with `{ "durationMs": 3600000 }` skips that rule until the duration ends. The rule stays enabled. `durationMs` is from 5 minutes to 7 days. A shorter or longer value returns `400` `VALIDATION_ERROR`. `POST /projects/:projectId/alerts/rules/:ruleId/unsilence` clears the skip. `GET /projects/:projectId/alerts` is the history. `POST /projects/:projectId/alerts/:alertId/resolve` marks one resolved. `POST /projects/:projectId/alerts/resolve-open` with `{ "ruleId": "rule_...", "limit": 20 }` marks the oldest open alerts resolved, up to 50. Each alert keeps its id. Leave `ruleId` out to include every rule. A second call does not resolve those alerts again. An unknown rule returns `404` `ALERT_NOT_FOUND`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`. Deleting a rule is soft and stops future checks.

## Webhooks

`POST /projects/:projectId/webhooks`

```json
{ "url": "https://example.com/taskflow", "description": "Ops", "events": ["job.completed", "job.failed"] }
```

`PATCH /projects/:projectId/webhooks/:webhookId` changes the URL, description, or event list in place. The endpoint id and signing secret stay. An empty event list returns `400` `VALIDATION_ERROR`. A URL that fails the environment check returns `400` `WEBHOOK_URL`.

The create and rotate responses include `secret` once. Later reads return `secretPrefix` only. `POST /projects/:projectId/webhooks/:webhookId/rotate` replaces the stored secret. Deliveries that have not been sent are signed with the new value. The previous secret stops working. The secret is `whsec_` plus random data, and it is stored so deliveries can be signed. Production projects accept `https` URLs that do not resolve to a private, loopback, or link-local address. A development project may also use `http://127.0.0.1` or `http://localhost`.

TaskFlow POSTs the same JSON body on every attempt. Headers are `TaskFlow-Delivery`, `TaskFlow-Event`, `TaskFlow-Timestamp`, and `TaskFlow-Signature` (`t=<unix>,v1=<hex>`). The signature is HMAC-SHA256 of `<timestamp>.<raw body>` using the current secret. A receiver should treat the delivery id as its dedupe key. Redirects are not followed. A non-2xx response is retried up to five times. A project can keep 10 endpoints.

`POST /projects/:projectId/webhooks/:webhookId/test` queues one `webhook.test` delivery for that endpoint. It does not wait for a job, and the endpoint does not need to subscribe to the test event. The body is `{ "webhookId", "test": true }` inside the normal signed envelope. Each call creates a new delivery id. A disabled endpoint returns `409` `WEBHOOK_DISABLED`.

`POST /projects/:projectId/webhooks/:webhookId/deliveries/:deliveryId/redeliver` queues that same delivery again. The body and delivery id stay the same. Previous attempts stay on the record. A delivery that is still pending returns `409` `DELIVERY_PENDING`. A disabled endpoint returns `409` `WEBHOOK_DISABLED`. The signature uses the current secret.

`POST /projects/:projectId/webhooks/redeliver-failed` with `{ "webhookId": "wh_...", "limit": 20 }` queues the oldest failed deliveries again, up to 50. Each delivery keeps its id. Leave `webhookId` out to include every endpoint. A pending or succeeded delivery is left alone. A second call does not queue those deliveries again. A paused endpoint named in `webhookId` returns `409` `WEBHOOK_DISABLED`, and its deliveries stay failed. When `webhookId` is left out, a paused endpoint is skipped. An unknown endpoint returns `404` `WEBHOOK_NOT_FOUND`. A limit outside 1 to 50 returns `400` `VALIDATION_ERROR`.

## Queues

`DELETE /projects/:projectId/queues/:queueId` removes the queue from the project. Waiting, delayed, active, and paused jobs return `409` `QUEUE_NOT_EMPTY`. Pausing the queue does not make those jobs disappear. A schedule or workflow that still names the queue returns `409` `QUEUE_IN_USE`. Finished and failed job records stay and keep their ids. The name can be used again after the delete.

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

`@taskflow/sdk` is a thin TypeScript client. Pass an API key and, when the API is not on `http://127.0.0.1:4000`, a `baseUrl`. The key is bound to one project, so the client reads that project on the first call. `jobs.create` returns when the API accepts the job. `jobs.wait` polls that job until it is completed, failed, or cancelled, then returns the same record, including the handler result or error. A wait that exceeds `timeoutMs` throws `JOB_WAIT_TIMEOUT`.

Reads retry up to two times after a network error or a 408, 429, 500, 502, 503, or 504 response. `jobs.create` retries those same responses only when `idempotencyKey` is set, because that key makes the replay return the original job. A create without a key is not retried. Other writes are not retried. `retries` and `retryDelayMs` change the bound. A `Retry-After` header is honored up to two seconds.
