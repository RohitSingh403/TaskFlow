# Architecture

TaskFlow runs four processes:

| Process | Responsibility |
| --- | --- |
| `apps/web` | Dashboard. Talks only to the API. |
| `apps/api` | Authentication, validation, job submission, queue controls, queries. |
| `apps/worker` | BullMQ consumers, handler registry, heartbeats, enqueue repair. |
| `apps/scheduler` | Turns due cron schedules into ordinary jobs. One process holds the Redis leader lock. |

Redis holds BullMQ queues, the API rate-limit counters, and the `taskflow:events` pub/sub channel. MongoDB holds users, projects, queue configuration, job records, attempts, workers, API keys, logs, side-effect receipts, schedules, workflow definitions, workflow runs, and audit entries.

A workflow run is one BullMQ flow. The parent job stays in `waiting-children` until every child completes. TaskFlow stores that parent as `waiting` until a worker starts it. The run status is derived from the step records: any failed step fails the run, every step completed completes the run, and an active step makes the run active.

The same scheduler leader evaluates alert rules after it produces due schedules. An alert is a MongoDB record. The worker process delivers outbound webhooks from a separate BullMQ queue named `webhooks`. That delivery is at least once, signed, and independent of the request that caused the event.

A queue configuration document is not the queue. The queue is the BullMQ key derived as `tf_<projectPublicId>_<queueName>`.

Workers poll queue configuration every few seconds. They open one BullMQ `Worker` per live queue, using that queue's concurrency and optional rate limit. Pause is stored on the queue in Redis. The worker converges Redis to the MongoDB `isPaused` flag, then re-reads the flag so a stale poll does not undo a newer pause.

On `SIGTERM` the worker stops polling, marks itself stopped, and closes its BullMQ workers so active jobs can finish or release their locks.

## Realtime

Worker and API publish small events: job id, status, queue, and optional duration. Payloads and stack traces stay in MongoDB and are loaded by an authorized request. Socket.IO joins `project:<publicId>` only after the access token's user owns that project. The browser invalidates its queries when an event arrives and again when the socket reconnects.

## Security boundary

Handlers are a code registry in `apps/worker/src/handlers.ts`. The public API accepts a handler name and a JSON payload. It does not accept source code, shell commands, or a function body.
