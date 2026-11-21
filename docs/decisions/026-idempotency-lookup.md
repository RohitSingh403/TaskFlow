# An idempotency key finds the original job

A client retries a submission with the same idempotency key and receives the original job. An operator who has that key needs the same lookup. `GET /jobs?idempotencyKey=` is an exact match on the stored key. It returns that one job, or an empty list when no job used the key. It does not search names or payloads.

The key must be 8 to 200 characters, the same bounds as submission. A shorter or longer value returns `400` `VALIDATION_ERROR`. The filter only changes which records the list returns.
