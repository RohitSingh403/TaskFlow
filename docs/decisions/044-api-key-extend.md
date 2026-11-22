# Extending an API key keeps its secret

Expiry used to be fixed at creation. Replacing a key that was about to expire meant a new secret. `PATCH /api-keys/:keyId` now accepts `expiresInDays`. A number from 1 to 365 sets `expiresAt` from now. `null` clears it. The id, prefix, hash, and scopes stay.

An expired key can be extended. The same secret works again. A value outside 1 to 365 returns `400` `VALIDATION_ERROR`. A revoked key returns `409` `API_KEY_REVOKED`. A member receives `403` `OWNER_REQUIRED`. An account that cannot see the project receives `404`.

Keys are managed from a user session. The TypeScript client does not change them.
