# Dismissing a dead letter job keeps the failure

A failed job should be able to leave the dead letter list without being queued again. `POST /jobs/:jobId/dismiss` sets `dismissedAt` and leaves the status `failed`. `POST /jobs/:jobId/restore` clears that time and puts the same job back on the list.

Only a failed job can be dismissed. A second dismiss, or a restore of a job that is still listed, returns `409` `JOB_NOT_DISMISSIBLE`. Bulk retry skips dismissed jobs. An explicit retry clears `dismissedAt`, so a later failure can show up on the list again.

`GET /jobs?status=failed&dismissed=false` is the open dead letter list. `dismissed=true` is the dismissed list. Leaving the parameter off returns both.
