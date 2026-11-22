# Queued jobs can change priority together

A priority is chosen when a job is submitted. Raising or lowering dozens of waiting jobs one at a time is the wrong tool. `POST /jobs/priority` takes a priority, an optional queue, and a limit from 1 to 50. It reads the oldest waiting and delayed jobs that do not already have that priority and uses the same priority change as a single job. Each job id stays. A delayed job keeps its delay. The idempotency key, schedule, and workflow run stay on the record.

A job that already has the priority is left alone, so a second call does not change it again. An active, completed, failed, or cancelled job is left alone. An unknown queue returns `404` `QUEUE_NOT_FOUND`. The monthly allowance does not change, because no new job is inserted. The caller repeats the request when more than 50 jobs still need the new priority.
