# Editing a schedule keeps its id

A cron that needs a new hour should not require a new schedule. `PATCH /schedules/:scheduleId` updates the same record. Jobs already created stay attached to that id, and a paused schedule stays paused.

A change to `cron` or `timeZone` recalculates `nextRunAt` from the current time. Other fields, such as the name, queue, or payload, do not move the next run. An invalid five-field pattern or time zone returns `400` `INVALID_SCHEDULE`. An empty body returns `400` `VALIDATION_ERROR`.
