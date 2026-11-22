# Delayed jobs can run now together

A delay that is no longer useful can sit on dozens of jobs. Running each one now is the wrong tool. `POST /jobs/promote-delayed` takes an optional queue and a limit from 1 to 50, reads the oldest delayed jobs, and uses the same promote as a single job. Each job id stays. The delay becomes 0 and the status becomes `waiting`. The idempotency key, schedule, and workflow run stay on that job.

A waiting or active job is left alone. After a job is promoted it is no longer delayed, so a second call does not promote it again. An unknown queue returns `404` `QUEUE_NOT_FOUND`. The monthly allowance does not change, because no new job is inserted. The caller repeats the request when more than 50 delayed jobs remain.
