# One scheduler produces recurring jobs

Recurring work is a schedule document plus ordinary jobs. The scheduler process reads due schedules and submits one job through the same MongoDB-then-Redis path as the API.

BullMQ still executes the job. The scheduler does not run handlers, and the API does not also fire cron. A Redis lock (`<prefix>:scheduler:leader`) makes a second scheduler process wait. The `nextRunAt` update is conditional, so two ticks cannot both insert the same occurrence. The job's idempotency key is `sched_<scheduleId>_<occurrence time>` in case the insert is retried.

A tick more than a minute late is skipped. Catching up every missed minute after an outage would dump a backlog onto the queue. Pause and resume follow the same rule: resume schedules the next future time.

Five-field cron is the only pattern. That caps a schedule at one occurrence per minute.
