# The oldest queues can share one concurrency

Concurrency is how many jobs a queue runs at once. Changing it on one queue keeps the queue id, the name, and whether the queue is paused. Jobs already waiting stay. When several queues should run the same number of jobs at once, editing each queue is the wrong tool. `POST /queues/concurrency` takes a concurrency from 1 to 100 and a limit from 1 to 50, reads the oldest queues, and uses the same concurrency change as a single queue. Each queue id stays.

A queue that already has that concurrency is left alone. A paused queue is included. A queue that still has jobs is included. A deleted queue is left alone. A second call returns `updated: 0` once those queues match. Workers pick up the new concurrency on the next sync. The caller repeats the request when more than 50 queues remain.
