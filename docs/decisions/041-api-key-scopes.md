# Changing API key scopes keeps the secret

A key that is too broad should not force a new secret onto every caller. `PATCH /api-keys/:keyId` accepts `scopes` and replaces the list on the same record. The id, prefix, hash, and expiry stay.

`scopes` must contain at least one known scope. Duplicate entries are stored once, in the platform's scope order. An empty list or an unknown scope returns `400` `VALIDATION_ERROR`. A revoked key returns `409` `API_KEY_REVOKED`. A member receives `403` `OWNER_REQUIRED`. An account that cannot see the project receives `404`.

Keys are managed from a user session. The TypeScript client does not change them.
