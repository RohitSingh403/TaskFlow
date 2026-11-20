# The client SDK is a thin API key wrapper

Callers should not have to assemble every job request by hand. `@taskflow/sdk` sends the same JSON the HTTP API already accepts and returns the same envelope.

The client authenticates with an API key. A key belongs to one project, so the client can discover that project instead of making every example pass a project id. A session cookie is a browser concern. The SDK does not log in, refresh tokens, or open a Socket.IO connection.

`jobs.create` returns the accepted job. Waiting for completion would hide the fact that execution happens later, on another process. The SDK also does not retry. A retried create without an idempotency key can insert a second job, and hiding that behind an automatic retry would make the duplicate look like a client bug. The caller passes `idempotencyKey` when a retry must replay the original job.

The default base URL is the local API. There is no hosted TaskFlow address to assume.
