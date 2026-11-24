# The oldest finished jobs can be run again together

Run again queues a new job and leaves the original record where it is. When several completed, failed, or cancelled jobs need that same new copy, replaying each row is the wrong tool. `POST /jobs/replay` takes a limit from 1 to 50, reads the oldest finished jobs, and uses the same replay as a single job. Each original id stays. The copy is a new waiting job, and its metadata records `replayedFrom`.

A waiting or active job is left alone. The copy does not keep the idempotency key, schedule, or workflow run. Because the originals stay finished, a second call copies them again. The copies count toward the monthly allowance. The allowance is checked before any copy in the batch is created. A queue at its waiting-job ceiling is skipped, and the other jobs still copy. The caller repeats the request when more than 50 finished jobs remain.
