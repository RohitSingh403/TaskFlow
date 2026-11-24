# The oldest schedules can be run together

Running one schedule queues one job and leaves the next cron time where it is. A paused schedule can still be run. When several schedules need that same one-off job, running each row is the wrong tool. `POST /schedules/run` takes a limit from 1 to 50, reads the oldest schedules, and uses the same run as a single schedule. Each schedule id stays. `nextRunAt` stays.

A deleted schedule is left alone. Each job uses a fresh idempotency key, so a second batch queues another job for every schedule that is still there. The jobs count toward the monthly allowance. The allowance is checked before any job in the batch is created. A queue at its waiting-job ceiling is skipped, and the other schedules still run. The caller repeats the request when more than 50 schedules remain.
