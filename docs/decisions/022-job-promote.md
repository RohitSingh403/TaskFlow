# Run now moves the delayed job onto the queue

A delay is part of the original job. Replay would create a second job, and that second job would count toward the monthly allowance. `POST /jobs/:jobId/promote` keeps the same job id and clears the remaining delay so a worker can take it.

The idempotency key, schedule, and workflow run stay on the record. The allowance does not change, because no new job is inserted. A second call finds the job waiting and returns `409` `JOB_NOT_DELAYED`. The same code is returned for a job that was never delayed.

Schedule run now is a different action. That route creates one new job from a cron definition and leaves `nextRunAt` alone.
