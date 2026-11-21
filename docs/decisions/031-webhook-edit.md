# Editing a webhook keeps its id and secret

Changing a URL or an event list should not require a new endpoint. `PATCH /webhooks/:webhookId` updates the same record. The signing secret and the deliveries already recorded stay attached to that id.

The URL is checked with the same rules as creation. A development project may use localhost. A production project requires a public `https` URL. An empty event list returns `400` `VALIDATION_ERROR`. Deliveries that have not been sent use the current URL and the current secret.
