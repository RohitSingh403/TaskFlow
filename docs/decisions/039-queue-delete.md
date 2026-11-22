# Deleting a queue leaves the jobs that still need it

A queue that is only paused still holds its jobs. `DELETE /queues/:queueId` counts waiting, delayed, active, and paused work. Any of those returns `409` `QUEUE_NOT_EMPTY`.

A schedule or a workflow step that still names the queue returns `409` `QUEUE_IN_USE`. Finished and failed job records stay, with the same ids. The queue name can be created again after the delete.

The SDK method is `queues.delete`.
