# Running queues can be paused together

Pausing one queue stops workers from taking new jobs and keeps the queue id. Jobs already waiting stay on that queue. An incident can leave many queues running, and pausing each row is the wrong tool. `POST /queues/pause` takes a limit from 1 to 50, reads the oldest queues that are still running, and uses the same pause as a single queue. Each queue id stays.

A queue that is already paused is left alone. A deleted queue is left alone. A second batch returns `paused: 0` when nothing is still running. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 queues remain. The caller needs `queues:write`.
