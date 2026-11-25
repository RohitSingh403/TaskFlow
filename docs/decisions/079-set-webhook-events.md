# The oldest webhooks can take one event list

Changing one endpoint's events keeps the endpoint id, the URL, and the signing secret. The pause state stays. When several endpoints should listen for the same events, editing each row is the wrong tool. `POST /webhooks/events` takes an event list and a limit from 1 to 50, reads the oldest endpoints, and uses the same event change as a single endpoint. Each endpoint id stays.

Duplicate entries are stored once, in the platform's event order. An endpoint that already has that list is left alone. A paused endpoint is included. A deleted endpoint is left alone. A second call returns `updated: 0` once those endpoints match. The caller repeats the request when more than 50 endpoints remain.
