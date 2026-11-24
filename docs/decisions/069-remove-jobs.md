# The oldest jobs that are not active can be removed together

Removing one job takes it off the queue and keeps the record. A completed job stays completed. Any other status becomes cancelled. An active job cannot be removed. When several jobs should leave the queue, removing each row is the wrong tool. `POST /jobs/remove` takes a limit from 1 to 50, reads the oldest jobs that are not active and have not already been removed, and uses the same remove as a single job. Each job id stays.

A job that is already removed is left alone. A second call returns `removed: 0` once those jobs are removed. An active job is left alone. The caller repeats the request when more than 50 removable jobs remain.
