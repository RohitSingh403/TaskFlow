# A manual run does not move the cron clock

The scheduler creates one job when `nextRunAt` is due. An operator sometimes needs that same job before the next tick, or while the schedule is paused. `POST /schedules/:id/run` creates one job with the stored handler and payload. `nextRunAt` stays where it is, so the following cron tick still happens on time. A paused schedule can be run. Pause continues to block the scheduler.

The job uses a fresh idempotency key, so two manual runs create two jobs. A cron tick keeps its own key, `sched_<scheduleId>_<occurrence time>`, and a manual run cannot consume that key. The job counts toward the monthly allowance. The queue's waiting-job ceiling still applies. A schedule whose queue was deleted returns 400.
