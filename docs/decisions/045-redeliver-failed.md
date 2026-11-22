# Failed webhook deliveries can be sent again together

A receiver that was down can leave many deliveries failed. Sending each one again is the wrong tool. `POST /webhooks/redeliver-failed` takes an optional endpoint id and a limit from 1 to 50, reads the oldest failed deliveries, and uses the same redelivery as a single delivery. Each one keeps its id, body, and earlier attempts. The signature uses the current secret.

A pending or succeeded delivery is left alone. After a delivery is queued its status is `pending`, so a second call does not queue it again. A paused endpoint named in the request returns `409` `WEBHOOK_DISABLED` and nothing from that call is queued. When the endpoint is left out, a paused endpoint is skipped and the others still go. An unknown endpoint returns `404` `WEBHOOK_NOT_FOUND`. The caller repeats the request when more than 50 failed deliveries remain.
