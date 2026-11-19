# Enqueue recovery instead of a transactional outbox

MongoDB and Redis cannot commit one transaction. The API inserts the job, then adds it to BullMQ with the same id.

- Redis rejects the add: the record is marked failed with `ENQUEUE_FAILED`. It does not sit in `waiting` forever.
- The process dies after Redis accepts it and before MongoDB records that: the sweep sees the BullMQ job and the duplicate id is harmless.
- The process dies before Redis accepts it: the sweep submits the same id.

A later version can replace the sweep with an outbox written in the same MongoDB transaction as the job. That needs a replica set. This version stays on a standalone MongoDB and makes the crash window explicit.
