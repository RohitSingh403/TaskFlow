# Paused schedules can be resumed together

Resuming one schedule starts its future cron ticks again and keeps the id. After an incident, many schedules can be paused, and resuming each row is the wrong tool. `POST /schedules/resume` takes a limit from 1 to 50, reads the oldest paused schedules, and uses the same resume as a single schedule. Each schedule id stays. `nextRunAt` stays when it is still in the future. When that time is already past, it moves forward to the next cron occurrence, so a resume does not fire a missed tick immediately.

A schedule that is already running is left alone. A deleted schedule is left alone. A second call returns `resumed: 0` when nothing is still paused. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 schedules remain.
