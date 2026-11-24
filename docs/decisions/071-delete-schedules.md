# The oldest schedules can be deleted together

Deleting one schedule pauses it and keeps the schedule id. A paused schedule can still be deleted. When several schedules should stop, deleting each row is the wrong tool. `POST /schedules/delete` takes a limit from 1 to 50, reads the oldest schedules that are still present, and uses the same delete as a single schedule. Each schedule id stays. The cron and the next run time stay on the record.

A schedule that is already deleted is left alone. A second call returns `deleted: 0` once those schedules are deleted. The caller repeats the request when more than 50 schedules remain.
