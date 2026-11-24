# The oldest empty queues can be deleted together

Deleting one queue keeps the queue id and the name. The queue is paused and leaves the list. Waiting, delayed, active, and paused jobs keep the queue, and so does a schedule or workflow that still names it. Finished and failed job records stay. When several empty queues should leave the project, deleting each row is the wrong tool. `POST /queues/delete` takes a limit from 1 to 50, reads the oldest queues that are still present, and uses the same delete as a single queue. Each queue id stays.

A queue that still has work is left alone. A queue that is still in use is left alone. A queue that is already deleted is left alone. Those skips do not stop the rest of the batch. A paused queue that is empty is included. A second call returns `deleted: 0` once the selected queues are gone or blocked. The caller repeats the request when more than 50 queues remain.
