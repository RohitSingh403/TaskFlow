# Update priority changes the queue order of the same job

A job's priority is chosen when it is submitted. Replay can copy it onto a new job, and that new job counts toward the monthly allowance. `POST /jobs/:jobId/priority` changes `high`, `medium`, or `low` on the job that is already waiting or delayed.

BullMQ stores a smaller number as a higher priority. The labels stay `high` = 1, `medium` = 5, and `low` = 10. A waiting job is moved within the prioritized list. A delayed job keeps its delay; the new priority is stored on that same queue entry and used when the delay ends. The idempotency key, schedule, and workflow run stay on the record. The monthly allowance does not change.

Sending the priority the job already has leaves the job as it is. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`.
