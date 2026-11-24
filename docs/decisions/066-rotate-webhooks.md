# The oldest webhook secrets can be replaced together

Rotating one endpoint stores a new signing secret and shows it once. A paused endpoint can still be rotated. When several endpoints need a new secret, rotating each row is the wrong tool. `POST /webhooks/rotate` takes a limit from 1 to 50, reads the oldest endpoints, and uses the same rotation as a single endpoint. Each endpoint id stays. The URL and events stay.

A deleted endpoint is left alone. The response includes each new secret once. Later reads return the prefix only. A second batch replaces those secrets again. Deliveries that have not been sent are signed with the secret stored at send time. The caller repeats the request when more than 50 endpoints remain.
