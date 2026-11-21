# Renaming an API key keeps its secret

A label should be fixable without issuing a new secret. `PATCH /api-keys/:keyId` changes the name or description on the same record. The prefix, hash, scopes, and expiry stay, so existing callers keep working.

A revoked key returns `409` `API_KEY_REVOKED`. The owner is the only person who can rename a key. A member receives `403` `OWNER_REQUIRED`. An account that cannot see the project receives `404`.
