# Run again queues a new job

Retry puts the same failed job back on its queue. A completed, cancelled, or delayed job still needs to be run another time, and that second run is a new effect. `POST /jobs/:jobId/replay` copies the handler, payload, queue, priority, attempts, backoff, and timeout into a new job.

The copy is waiting immediately. A delay on the original is not copied, because that wait already belonged to the first run. The idempotency key, schedule, and workflow run stay on the original. Replaying a workflow step does not move the run. It creates a standalone job. The original record is left as it was.

The copy counts toward the monthly allowance. The queue waiting ceiling still applies. Each call creates another job. The new job's metadata records `replayedFrom` as the source job id.
