# TaskFlow

Reliable background processing, made observable.

TaskFlow is a MERN + Redis platform for submitting work, executing it on separate Node.js workers, and inspecting what happened. Redis and BullMQ are the source of truth for queue execution. MongoDB stores accounts, project configuration, and the execution history the dashboard reads.

An API request returns as soon as the job is accepted. It does not wait for the handler to finish.

## What this version includes

- Email and password accounts, Argon2id hashes, short-lived access tokens, and rotating refresh tokens stored only as SHA-256 hashes.
- API keys stored as SHA-256 hashes. A key can expire after 1 to 365 days, or stay valid until the owner revokes it. Rename changes the label and keeps the secret. Scopes and expiry can change on that same key.
- Projects with development and production environments. Development projects may simulate handler failures. Production projects reject that field.
- Queues with concurrency, an optional rate limit, a waiting-job ceiling, and pause / resume. Pause queues stops the oldest running queues, up to 50, and keeps each queue id. Jobs already waiting stay. A queue that is already paused is left alone. Resume queues starts the oldest paused queues again, up to 50, and keeps each queue id. A queue that is already running is left alone. Delete removes an empty queue. Waiting, delayed, active, and paused jobs keep it, and so does a schedule or workflow that still uses it.
- Job submission by session or API key, with priority, delay, timeout, retry, and idempotency keys.
- A jobs list window. `from` and `to` keep jobs created in that range. Either side can be left open. An idempotency key returns the one job that used it.
- Run again. Replaying a job queues a new copy with the same handler and payload. The original job stays as it is.
- Run now. A delayed job moves onto the queue under the same id. The monthly allowance stays where it is. Run delayed does that for the oldest delayed jobs, up to 50, and keeps each job id.
- Reschedule. A waiting or delayed job can take a new delay, up to 30 days. The same job id stays, and the monthly allowance does not change. Reschedule queued does that for the oldest waiting and delayed jobs, up to 50. The delay is measured from the call. A waiting workflow step stays on its run.
- Update priority. A waiting or delayed job can move between high, medium, and low. The same job id stays, and the monthly allowance does not change. Set priority does that for the oldest waiting and delayed jobs, up to 50. A job that already has that priority is left alone.
- Move. A waiting or delayed job can move to another queue in the same project. A workflow step stays on the queue that owns its run. The monthly allowance does not change. Move queued does that for the oldest waiting and delayed jobs, up to 50, and keeps each job id.
- A dead-letter view of jobs that used their attempts, and a bulk retry that puts those same jobs back on their queues. Dismiss takes a failed job off that list and leaves it failed. Dismiss failed does that for the oldest jobs still listed, up to 50. Restore dismissed puts the oldest of those jobs back on the list, up to 50. They stay failed. Bulk retry skips dismissed jobs.
- A bulk cancel for waiting and delayed jobs. Active jobs stay. Workflow steps are left for the run that owns them.
- Recurring schedules. A separate scheduler process creates one normal job per cron tick. Editing a schedule keeps its id. A new cron or time zone recalculates the next run, and the pause state stays as it is. Run now queues one job and leaves the next cron time unchanged. Run schedules does that for the oldest schedules, up to 50, and keeps each schedule id. A paused schedule can still run. A second call queues another job. Pause schedules stops the oldest running schedules, up to 50, and keeps each schedule id. The next run time stays. A schedule that is already paused is left alone. Resume schedules starts the oldest paused schedules again, up to 50, and keeps each schedule id. A next run that is already past moves forward. A schedule that is already running is left alone.
- Workflows. A run is a tree of normal jobs. Children finish before the parent that waits on them. Edit changes the name or description and keeps the workflow id. Steps replaces that tree for the next run. A run that already started keeps the steps it began with. Pause stops new runs and leaves runs that already started. Pause workflows does that for the oldest running workflows, up to 50, and keeps each workflow id. A workflow that is already paused is left alone. Resume workflows starts the oldest paused workflows again, up to 50, and keeps each workflow id. A workflow that is already running is left alone. Run workflows starts one run of each of the oldest workflows that can still accept a run, up to 50, and keeps each workflow id. A paused workflow is left alone, and so is a deleted workflow. A second call starts another run. Cancel runs stops the oldest waiting runs, up to 50, and keeps each run id. A run that is already finished, already cancelled, or has an active step is left alone. A run whose workflow was deleted is left alone. Cancel removes the steps that are still waiting and keeps the run id. An active step is left to finish, and that cancel is refused until it does.
- Alert rules for queue backlog, failure rate, offline workers, and long-running jobs. The scheduler opens an in-app alert and then waits out a cooldown. Edit changes the name, threshold, or cooldown and keeps the rule id and its silence. Silence skips a rule until a chosen time. The rule stays enabled. Silence rules does that for the oldest rules that are still checking, up to 50, and keeps each rule id. A rule that is already silenced is left alone. Clear silences starts the oldest silenced rules checking again, up to 50, and keeps each rule id. A rule that is already checking is left alone. Pause rules stops the oldest enabled rules, up to 50, and keeps each rule id and its silence. A rule that is already paused is left alone. A paused rule is not checked. Resume rules starts the oldest paused rules checking again, up to 50, and keeps each rule id and its silence. A rule that is already enabled is left alone. A silence that is still in the future keeps that rule from opening an alert. Resolve open marks the oldest open alerts resolved, up to 50, and keeps each alert id.
- Signed outbound webhooks for job completion, failure, cancellation, and fired alerts. Delivery is at least once from the worker. Edit changes the URL or events and keeps the endpoint id and signing secret. Send test queues a `webhook.test` delivery without waiting for a job. Send tests does that for the oldest enabled endpoints, up to 50, and keeps each endpoint id and signing secret. A paused endpoint is left alone, and so is a deleted endpoint. A second call queues another test. Rotate replaces the signing secret. Rotate secrets does that for the oldest endpoints, up to 50, including a paused endpoint, and keeps each endpoint id. The new secrets are shown once. A second call replaces them again. Send again queues that same delivery id. Send failed again queues the oldest failed deliveries and keeps each delivery id. Pause webhooks stops the oldest enabled endpoints, up to 50, and keeps each endpoint id and signing secret. A webhook that is already paused is left alone. A paused endpoint refuses a new test delivery. Resume webhooks starts the oldest paused endpoints again, up to 50, and keeps each endpoint id and signing secret. A webhook that is already enabled is left alone. An enabled endpoint can accept a test again.
- A separate worker process, heartbeats, and health derived from those heartbeats.
- Attempt history, structured logs, and dashboard metrics.
- Socket.IO updates scoped to a project room. The client refetches after reconnect.
- A fixed handler registry. Callers name a handler. They cannot submit code.
- A TypeScript client, `@taskflow/sdk`. It submits work with an API key and returns when the API accepts the job. `jobs.wait` polls until the job finishes. Reads retry transient failures. A create retries only when it has an idempotency key.
- Project members. The owner adds an existing account by email. Members can operate the project. The owner can transfer the project to a member and stays on as a member. API keys, settings, and deletion stay with the current owner.
- Monthly job allowances. A developer plan includes 2,000 created jobs per UTC month, and a scale plan includes 50,000. TaskFlow does not collect card payments.
- Job retention. Finished, failed, and cancelled jobs are deleted after 30 days by default. The owner can choose 1 to 365 days. Waiting and active jobs stay.

## Stack

React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, Recharts, Socket.IO, Node.js, Express, MongoDB, Redis, BullMQ, Vitest, Supertest, Docker Compose.

## Architecture

```text
Browser  --->  API  --->  MongoDB   (accounts, config, history)
                 |---->  Redis     (BullMQ queues, rate limits, events)
                              |
                              v
                           Worker processes
                              |
                              +--> MongoDB status, attempts, logs
                              +--> Redis pub/sub --> API Socket.IO rooms
```

BullMQ states map to the application statuses `waiting`, `delayed`, `active`, `completed`, and `failed`. `cancelled` is an application state used when a waiting or delayed job is removed. The mapping lives in `packages/shared`.

### Job lifecycle

```text
WAITING -> ACTIVE -> COMPLETED

WAITING -> ACTIVE -> FAILED -> WAITING or DELAYED -> ACTIVE -> COMPLETED
```

A failed attempt stays retryable until `attemptsMade` reaches `maxAttempts`. Exponential backoff follows BullMQ: the first run is immediate, then the base delay, then double that, then double again. A 5 second base is immediate, 5s, 10s, 20s.

### Failure you should expect

Processing is at least once. This sequence is possible:

1. A worker sends an email.
2. The process dies before BullMQ records completion.
3. Another attempt runs.

TaskFlow does not claim exactly-once execution. Each built-in handler writes a receipt keyed by the job id before it treats the effect as done. A later attempt for that same job returns the original receipt instead of creating a second message id. A new job is a new effect. Idempotency keys stop a client retry from creating that second job in the first place.

There is a second gap between MongoDB and Redis. The API writes the job record, then adds the BullMQ job. If the process dies in between, a worker sweep finds records still marked `enqueued: false` and submits the same job id again. BullMQ treats that id as a duplicate, so the sweep can run more than once. This is a repair pass, not a transactional outbox.

### Handlers

| Name | Purpose |
| --- | --- |
| `send-email` | Transactional email |
| `generate-report` | Report document |
| `process-records` | Bounded record batch |
| `send-notification` | In-app, push, or email notification |

Payloads are validated with Zod. Fields named like `password`, `token`, `secret`, or `apiKey` are redacted in API responses and logs.

## Local setup

Requirements: Node.js 22, MongoDB 7, Redis 7.

```bash
cp .env.example .env
# Replace both JWT secrets with long random strings.

docker compose up -d mongodb redis
npm install
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000
- Health: http://localhost:4000/health

`npm run dev` starts the API, one worker, one scheduler, and the web app. The worker and the scheduler are separate processes. The dashboard does not pretend to spawn them. Run one scheduler. A Redis lock makes an extra scheduler wait instead of creating a second copy of each occurrence.

To run the same processes in containers, set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`, then:

```bash
docker compose up --build
```

Create a demo account without printing the password:

```bash
SEED_EMAIL=ada@example.com SEED_PASSWORD='choose-a-real-password' npm run seed
```

## Environment

See `.env.example`. The API binds to `0.0.0.0:$PORT`. Secrets, job history, and queue data are stored in MongoDB and Redis, not on the local disk. The worker heartbeat file `/tmp/taskflow-worker-alive` is only a container health check.

## Tests

```bash
npm run typecheck
npm test
```

`npm test` covers the status machine, backoff schedule, redaction, and an integration lifecycle against local MongoDB and Redis database 1:

- register, refresh, create a project, and create an API key
- submit a job and wait for a worker to complete it
- replay the same idempotency key, and reject the same key with a different body
- fail once, retry, and complete
- pause a queue and show that a new job stays waiting
- cancel a delayed job
- reject a second user and reject simulated failures on a production project
- run one handler twice and keep a single side effect

No throughput number is published here. `tests/load/submit.js` is a k6 sketch and has not been executed in this environment. A useful measurement records the machine, worker concurrency, handler work, duration, submit rate, complete rate, API latency, failure percentage, and backlog. Inventing a jobs-per-second claim would not make those results real.

## API

Versioned under `/api/v1`. Successful responses use `{ success, data, meta }`. Errors use `{ success: false, error: { code, message, details? }, meta }`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account |
| POST | `/auth/login` | Start a session |
| POST | `/auth/refresh` | Rotate the refresh cookie |
| POST | `/auth/logout` | Revoke the refresh token |
| GET | `/auth/me` | Current user |
| GET | `/projects` | List visible projects |
| POST | `/projects` | Create a project and default queues |
| GET | `/projects/:id/queues` | List queues and BullMQ counts |
| POST | `/projects/:id/queues/:queueId/pause` | Pause a queue |
| POST | `/projects/:id/queues/pause` | Pause up to 50 running queues and keep their ids |
| POST | `/projects/:id/queues/resume` | Resume up to 50 paused queues and keep their ids |
| POST | `/projects/:id/jobs` | Submit a job |
| POST | `/projects/:id/jobs/promote-delayed` | Run up to 50 delayed jobs now and keep their ids |
| POST | `/projects/:id/jobs/priority` | Change the priority of up to 50 waiting or delayed jobs |
| POST | `/projects/:id/jobs/move` | Move up to 50 waiting or delayed jobs to another queue |
| POST | `/projects/:id/jobs/reschedule` | Give up to 50 waiting or delayed jobs a new delay |
| POST | `/projects/:id/jobs/:jobId/dismiss` | Take a failed job off the dead letter list |
| POST | `/projects/:id/jobs/dismiss-failed` | Take up to 50 failed jobs off the dead letter list |
| POST | `/projects/:id/jobs/restore-dismissed` | Put up to 50 dismissed jobs back on the dead letter list |
| POST | `/projects/:id/jobs/:jobId/restore` | Put a dismissed job back on the dead letter list |
| POST | `/projects/:id/schedules` | Create a recurring schedule |
| PATCH | `/projects/:id/schedules/:scheduleId` | Change a schedule and keep its id |
| POST | `/projects/:id/schedules/:scheduleId/pause` | Pause future occurrences |
| POST | `/projects/:id/schedules/pause` | Pause up to 50 running schedules and keep their ids |
| POST | `/projects/:id/schedules/resume` | Resume up to 50 paused schedules and keep their ids |
| POST | `/projects/:id/schedules/run` | Queue one job for each of up to 50 schedules |
| POST | `/projects/:id/workflows` | Create a workflow |
| PATCH | `/projects/:id/workflows/:workflowId` | Change a workflow name or its steps and keep its id |
| POST | `/projects/:id/workflows/:workflowId/pause` | Stop new runs and keep the workflow |
| POST | `/projects/:id/workflows/pause` | Pause up to 50 running workflows and keep their ids |
| POST | `/projects/:id/workflows/resume` | Resume up to 50 paused workflows and keep their ids |
| POST | `/projects/:id/workflows/runs/cancel` | Cancel up to 50 waiting runs and keep their ids |
| POST | `/projects/:id/workflows/runs` | Start one run of each of up to 50 workflows |
| POST | `/projects/:id/workflows/:workflowId/runs` | Start a workflow run |
| POST | `/projects/:id/workflows/:workflowId/runs/:runId/cancel` | Cancel the steps that are still waiting |
| POST | `/projects/:id/alerts/rules` | Create an alert rule |
| PATCH | `/projects/:id/alerts/rules/:ruleId` | Change an alert rule and keep its id |
| POST | `/projects/:id/alerts/rules/:ruleId/silence` | Skip a rule until a chosen time |
| POST | `/projects/:id/alerts/rules/silence` | Silence up to 50 rules that are still checking and keep their ids |
| POST | `/projects/:id/alerts/rules/unsilence` | Clear silence on up to 50 rules and keep their ids |
| POST | `/projects/:id/alerts/rules/pause` | Pause up to 50 enabled rules and keep their ids |
| POST | `/projects/:id/alerts/rules/resume` | Resume up to 50 paused rules and keep their ids |
| GET | `/projects/:id/alerts` | Alert history |
| POST | `/projects/:id/alerts/resolve-open` | Resolve up to 50 open alerts and keep their ids |
| POST | `/projects/:id/webhooks` | Register a signed webhook |
| PATCH | `/projects/:id/webhooks/:webhookId` | Change a webhook URL or its events |
| PATCH | `/projects/:id/api-keys/:keyId` | Change an API key's name, scopes, or expiry and keep its secret |
| POST | `/projects/:id/webhooks/:webhookId/rotate` | Replace the signing secret |
| POST | `/projects/:id/webhooks/rotate` | Replace the signing secret on up to 50 webhooks |
| POST | `/projects/:id/webhooks/:webhookId/test` | Queue a signed test delivery |
| POST | `/projects/:id/webhooks/test` | Queue a test for each of up to 50 enabled webhooks |
| POST | `/projects/:id/webhooks/redeliver-failed` | Queue up to 50 failed deliveries again and keep their ids |
| POST | `/projects/:id/webhooks/pause` | Pause up to 50 enabled webhooks and keep their ids |
| POST | `/projects/:id/webhooks/resume` | Resume up to 50 paused webhooks and keep their ids |
| GET | `/projects/:id/jobs/:jobId` | Job detail |
| POST | `/projects/:id/jobs/:jobId/retry` | Retry a failed job |
| GET | `/projects/:id/analytics/overview` | Operational summary |

Routes are project-scoped so a list cannot cross tenants. A user who does not own a project receives `404`, not a hint that the record exists. API keys are bound to one project and carry scopes.

The full request shapes are the Zod schemas in `packages/shared/src/schemas.ts`. More detail is in `docs/api/rest.md`.

## Project layout

```text
apps/api        Express API and Socket.IO
apps/worker     BullMQ workers and recovery sweep
apps/scheduler  Cron schedules into normal jobs
apps/web        Operations dashboard
packages/shared Status mapping, schemas, backoff math
packages/server MongoDB models and queue lifecycle
packages/sdk    TypeScript client for the HTTP API
```

## Further reading

- `docs/architecture/overview.md`
- `docs/database/models.md`
- `docs/api/rest.md`
- `docs/decisions/`

## Known limits

- A project has one owner at a time. Members can operate it, and they cannot change settings, the plan, API keys, or delete it. The owner can transfer that role to a member. TaskFlow does not collect a card payment.
- One API process fans Socket.IO out from its own subscription. Several API processes can each subscribe to Redis, but there is no cross-node Socket.IO adapter beyond that.
- Completed BullMQ entries are trimmed. MongoDB job records are deleted after the project's retention window. Logs expire after 14 days. TaskFlow does not copy either store to an archive.
- Rate limits on the BullMQ worker are per queue and shared through Redis. API rate limits also use Redis.
- The built-in handlers simulate work. They are the trusted registry a real deployment would replace with its own functions, still without accepting arbitrary code from API callers.
- A scheduler that is down for more than a minute skips the ticks it missed. It does not replay a backlog when it returns.
- A workflow is a tree. A step can wait for several earlier steps, and each earlier step can feed only one later step. A failed step keeps every step that waits on it from running until that failed job is retried. Cancel removes the steps that are still waiting.
- Alerts stay in the dashboard until a webhook is registered for `alert.fired`. A rule that remains true does not open another alert until its cooldown has passed.
- `@taskflow/sdk` retries a create only when that create has an idempotency key. Other writes are not retried. `jobs.wait` polls the accepted job. It does not open a socket.
