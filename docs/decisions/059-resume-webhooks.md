# Paused webhooks can be resumed together

Resuming one webhook lets new deliveries start again and keeps the endpoint id and signing secret. After an incident, many endpoints can still be paused, and enabling each row is the wrong tool. `POST /webhooks/resume` takes a limit from 1 to 50, reads the oldest paused endpoints, and uses the same enable as a single webhook. Each endpoint id stays. The URL, events, and signing secret stay.

A webhook that is already enabled is left alone. A deleted webhook is left alone. A new test delivery to a resumed endpoint is accepted. A second batch returns `resumed: 0` when nothing is still paused. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 webhooks remain.
