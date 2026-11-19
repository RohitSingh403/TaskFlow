# Job lifecycle

1. The API validates the handler name and payload.
2. If an idempotency key already exists for the project, the original job is returned when the request hash matches. A different body returns `409 IDEMPOTENCY_CONFLICT`.
3. Waiting, delayed, and prioritized BullMQ counts are compared with the queue's `maxWaiting`. Over the ceiling, the API returns `429 QUEUE_BACKPRESSURE` and does not create a record.
4. MongoDB inserts the job with `enqueued: false`.
5. BullMQ `Queue.add` uses the public job id. The record is then marked `enqueued: true`.
6. If Redis accepts the job but the client sees an error, the API looks the job up by id and keeps it. If Redis does not have it, the record is marked failed with `ENQUEUE_FAILED`.
7. The worker runs the handler. `attemptsMade` during the call is BullMQ's previous count plus one, because BullMQ increments that counter when the attempt finishes.
8. Active, completed, and failed events write the job, the attempt, and a log line.
9. While attempts remain, the job returns to `waiting` or `delayed`. The last failure is terminal `failed`.
10. Every 15 seconds the worker re-enqueues records that never reached Redis and copies BullMQ state onto records that have been quiet for 20 seconds.

Cancellation removes a waiting or delayed BullMQ job and sets `cancelled`. Active jobs are left alone. Retry requeues a failed job, or calls BullMQ `Job.retry` when the failed entry is still present.

Manual retry is the one transition allowed out of a terminal state. Other late events cannot move `completed`, `failed`, or `cancelled` backwards.
