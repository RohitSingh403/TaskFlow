# At-least-once handlers

BullMQ locks a job while a worker runs it. If the worker dies, the lock expires and the job can run again. Retries have the same shape. TaskFlow therefore treats every handler as retryable.

The built-in handlers insert a receipt with a unique key `handler:jobId` before they report success. The unique index decides the winner. The loser, including a later attempt of the same job, reads the stored result. That prevents a second message id for one job. It does not prevent two different jobs from sending two emails, and it does not make the queue exactly-once.

Client retries are a separate problem. An idempotency key is unique per project and is hashed with the request body. The same key and body return the original job. The same key and a different body return 409.
