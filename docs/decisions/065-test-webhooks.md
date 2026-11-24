# The oldest webhooks can be tested together

Sending a test queues one `webhook.test` delivery and leaves the endpoint id and signing secret where they are. A paused endpoint refuses that test. When several endpoints need the same check, sending each row is the wrong tool. `POST /webhooks/test` takes a limit from 1 to 50, reads the oldest enabled endpoints, and uses the same test as a single endpoint. Each endpoint id stays. The signing secret stays.

A paused endpoint is left alone, and so is a deleted endpoint. Each test uses a new delivery id, so a second batch queues another test for every endpoint that is still enabled. The caller repeats the request when more than 50 endpoints remain.
