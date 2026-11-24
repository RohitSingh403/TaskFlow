# Paused queues can be resumed together

Resuming one queue lets workers take jobs again and keeps the queue id. Jobs already waiting stay on that queue. After an incident, many queues can be paused, and resuming each row is the wrong tool. `POST /queues/resume` takes a limit from 1 to 50, reads the oldest paused queues, and uses the same resume as a single queue. Each queue id stays.

A queue that is already running is left alone. A deleted queue is left alone. A second batch returns `resumed: 0` when nothing is still paused. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 queues remain. The caller needs `queues:write`.
