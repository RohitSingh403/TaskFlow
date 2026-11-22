# Dismissing failed jobs in a batch

The dead letter list can already dismiss one failed job. Clearing a queue of failures one row at a time is the wrong tool when the list is long. `POST /jobs/dismiss-failed` sets `dismissedAt` on the oldest failed jobs that are still listed. The status stays `failed`, and each job keeps its id.

The body matches bulk retry: an optional queue name and a limit from 1 to 50. The default limit is 20. Waiting, delayed, active, completed, and cancelled jobs are not selected. A job that is already dismissed is not selected again, so a second call returns an empty list. An unknown queue returns `404` `QUEUE_NOT_FOUND`.

The SDK method is `jobs.dismissFailed`.
