# Finished jobs are deleted, not archived

Logs already expire after 14 days. Job records did not, so a long-running project would keep every completed, failed, and cancelled job. The owner sets `jobRetentionDays` from 1 to 365. The default is 30. The scheduler leader deletes those terminal records when `updatedAt` is older than the window. Waiting, delayed, and active jobs stay, including a workflow step that has not finished. A workflow run is removed only when every step is terminal and older than the window.

Each tick deletes at most 200 standalone jobs and 20 workflow runs per project, so a backlog drains over later ticks. BullMQ's copy of a removed job is removed when it is not active. TaskFlow does not write the deleted records anywhere else. An idempotency key that belonged to a deleted job can be used again, and that creates a new job.
