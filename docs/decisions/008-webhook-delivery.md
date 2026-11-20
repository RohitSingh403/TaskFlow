# Webhook delivery is at least once, signed, and checked for private targets

A webhook tells another system that a job finished, failed, or was cancelled, or that an alert opened. The API request that caused the event does not wait for the customer URL. The worker consumes an internal BullMQ queue named `webhooks` and POSTs the body.

The delivery id is the receiver's dedupe key. A unique index on webhook, event, and resource id keeps a repeated lifecycle call from creating a second delivery. Retries send the body that was stored when the delivery was recorded. Five attempts use exponential backoff. A 2xx response completes the delivery. A redirect is a failure, so a public URL cannot bounce the request onto a private address. The request times out after five seconds.

The signing secret is shown once, on create and on rotate, and stored so the worker can compute `HMAC-SHA256(secret, "<unix>.<raw body>")`. Later API reads return a prefix. In-flight retries use the current secret, so a rotation invalidates a signature that has not been sent yet.

Production endpoints must be `https` and must not resolve to a loopback, private, link-local, or unspecified address. The check runs at registration and again immediately before the POST. A development project may use `http://127.0.0.1` or `http://localhost` so a local receiver can be tested. Other HTTP URLs are rejected. In-app alerts stay in MongoDB. A webhook is an additional channel, not a replacement.
