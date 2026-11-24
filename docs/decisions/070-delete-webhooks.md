# The oldest webhooks can be deleted together

Deleting one webhook disables it and keeps the endpoint id. A paused webhook can still be deleted. When several endpoints should stop, deleting each row is the wrong tool. `POST /webhooks/delete` takes a limit from 1 to 50, reads the oldest endpoints that are still present, and uses the same delete as a single webhook. Each endpoint id stays.

A webhook that is already deleted is left alone. A second call returns `deleted: 0` once those endpoints are deleted. The caller repeats the request when more than 50 endpoints remain.
