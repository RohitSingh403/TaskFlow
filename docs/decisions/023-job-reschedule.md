# Reschedule changes the delay on the same job

Run now clears a delay. An operator also needs to push a waiting job later, or replace the remaining delay, without creating a second job. `POST /jobs/:jobId/reschedule` takes `delayMs` from 0 through 30 days, the same range as job submission. The delay is measured from the time of the call.

A delayed job keeps its BullMQ id. A positive delay uses `changeDelay`. A delay of 0 promotes it, which is the same queue move as run now. A waiting job that needs a delay is removed and queued again under the same id, because BullMQ only changes the delay of a job that is already delayed. The idempotency key, schedule, and workflow run stay on the record. The monthly allowance does not change.

A workflow step that is already waiting stays where it is. Removing it to add a delay would drop the link to its run, so that call returns `409` `WORKFLOW_JOB`. A delayed workflow step can still take a new delay, because that update keeps the same queue entry. An active, completed, failed, or cancelled job returns `409` `JOB_NOT_QUEUED`.
