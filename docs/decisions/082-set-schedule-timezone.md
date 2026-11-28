# The oldest schedules can share one time zone

A time zone is where a cron pattern is interpreted. Changing it on one schedule keeps the schedule id, the name, the cron, and whether the schedule is paused. The next run is calculated again. When several schedules should fire in the same place, editing each row is the wrong tool. `POST /schedules/timezone` takes an IANA time zone and a limit from 1 to 50, reads the oldest schedules, and uses the same time zone change as a single schedule. Each schedule id stays.

A schedule that already uses that time zone is left alone. A paused schedule is included, and it stays paused. A deleted schedule is left alone. An unknown time zone changes none of the schedules. A second call returns `updated: 0` once those schedules match. The caller repeats the request when more than 50 schedules remain.
