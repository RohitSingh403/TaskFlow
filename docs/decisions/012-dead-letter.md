# Failed jobs stay on their queue

A job that exhausts its attempts is already terminal in BullMQ. TaskFlow keeps that record as `failed` on the queue that ran it. A second queue would be a second job, and the allowance, the idempotency key, and the workflow step all refer to the original record.

`POST /jobs/retry-failed` reads the oldest failed records for the project, optionally one queue, and calls the same retry used by a single job. The request retries at most 50. An operator who has more repeats the call. A job that is no longer failed is skipped. Retry does not count as a new job for the monthly allowance.
