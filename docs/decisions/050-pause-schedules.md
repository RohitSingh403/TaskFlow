# Running schedules can be paused together

Pausing one schedule stops its future cron ticks and keeps the id. An incident can leave many of them running, and pausing each row is the wrong tool. `POST /schedules/pause` takes a limit from 1 to 50, reads the oldest schedules that are still running, and uses the same pause as a single schedule. Each schedule id stays. `nextRunAt` stays where it is, so a later resume uses the same forward-only rule as a single resume.

A schedule that is already paused is left alone. A deleted schedule is left alone. A second call returns `paused: 0` when nothing is still running. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 schedules remain.
