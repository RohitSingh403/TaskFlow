# Alerts are in-app records checked by the scheduler leader

Backlog, failure rate, offline workers, and long-running jobs are operator signals. They do not need a second polling process. The scheduler already holds a Redis leader lock so only one process produces cron jobs. That same tick evaluates enabled alert rules.

A true rule opens one alert, then stores `lastTriggeredAt`. Another tick inside the cooldown does not open a duplicate, even if the condition is still true. Resolving an alert does not reset that cooldown. The claim is a conditional update, so two overlapping ticks cannot both insert the event.

Delivery stops at the dashboard and the `alert.fired` Socket.IO event. Calling a customer URL is a webhook, and that is a separate feature.
