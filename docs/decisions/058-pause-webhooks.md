# Enabled webhooks can be paused together

Pausing one webhook stops new deliveries and keeps the endpoint id and signing secret. During an incident, many endpoints can still be enabled, and pausing each row is the wrong tool. `POST /webhooks/pause` takes a limit from 1 to 50, reads the oldest enabled endpoints, and uses the same pause as a single webhook. Each endpoint id stays. The URL, events, and signing secret stay.

A webhook that is already paused is left alone. A deleted webhook is left alone. A new test delivery to a paused endpoint still returns `409` `WEBHOOK_DISABLED`. A second batch returns `paused: 0` when nothing is still enabled. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 webhooks remain.
