# Move sends the same job to another queue

A job is submitted to one queue. Replay can place a copy on a different queue, and that copy counts toward the monthly allowance. `POST /jobs/:jobId/queue` moves the waiting or delayed job itself. The job id, delay, priority, idempotency key, and schedule stay. The destination must be a live queue in the same project.

The destination's waiting ceiling still applies. When that queue is full, the call returns `429` `QUEUE_BACKPRESSURE` and the job stays where it is. Naming the queue the job is already on leaves the job as it is. A workflow step stays on the queue that owns its run, because moving the BullMQ entry would drop that link, and returns `409` `WORKFLOW_JOB`. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`.
