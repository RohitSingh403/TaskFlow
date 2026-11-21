# A test delivery checks an endpoint without a job

An operator should be able to confirm a URL and a signing secret before a job finishes. `POST /webhooks/:webhookId/test` queues one `webhook.test` delivery on that endpoint. The event is not part of the subscription list, so a test does not require the endpoint to listen for it, and a real job event does not become a test.

The body uses the same signed envelope as every other delivery. `data` is `{ webhookId, test: true }`. Each call creates a new delivery id, so a receiver can tell one test from the next. A disabled endpoint returns `409` `WEBHOOK_DISABLED`. The worker delivers the test with the current secret.
