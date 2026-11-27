# The oldest queues can share one waiting ceiling

The waiting ceiling is how many jobs may sit waiting, delayed, or paused before a new submit is refused. Changing it on one queue keeps the queue id, the name, the concurrency, and whether the queue is paused. Jobs already waiting stay. When several queues should refuse new work at the same depth, editing each queue is the wrong tool. `POST /queues/max-waiting` takes a ceiling from 1 to 100,000 and a limit from 1 to 50, reads the oldest queues, and uses the same ceiling change as a single queue. Each queue id stays.

A queue that already has that ceiling is left alone. A paused queue is included. A queue that still has jobs is included. A deleted queue is left alone. A second call returns `updated: 0` once those queues match. The caller repeats the request when more than 50 queues remain.
