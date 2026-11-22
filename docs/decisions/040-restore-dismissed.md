# Restoring dismissed jobs in a batch

Dismissing failed jobs in a batch needs the same path back. `POST /jobs/restore-dismissed` clears `dismissedAt` on the oldest dismissed jobs. The status stays `failed`, and each job keeps its id, so it returns to the open dead letter list.

The body matches bulk dismiss: an optional queue name and a limit from 1 to 50. The default limit is 20. Jobs are chosen by the earliest `dismissedAt`. A job that is still listed is not selected. A second call returns an empty list. An unknown queue returns `404` `QUEUE_NOT_FOUND`.

The SDK method is `jobs.restoreDismissed`.
