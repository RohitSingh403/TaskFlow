# An API key can expire without being revoked

A key used to stay valid until someone revoked it. That is still the default. `expiresInDays` on create stores `expiresAt` from 1 to 365 days ahead. The secret is still shown once and only the hash is stored.

Authentication checks the date before the request runs. An expired key returns `401` with code `API_KEY_EXPIRED`. A revoked key stays `UNAUTHORIZED`. The list marks a past `expiresAt` as `expired` even before the next request. The owner can still revoke an expired key. There is no way to extend a key. Create a new one.
