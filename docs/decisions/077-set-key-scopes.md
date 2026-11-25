# The oldest API keys can take one scope list

Changing one key's scopes keeps the key id, the prefix, and the secret. The expiry stays. When several keys should carry the same list, editing each row is the wrong tool. `POST /api-keys/scopes` takes a scope list and a limit from 1 to 50, reads the oldest keys that are still active or expired, and uses the same scope change as a single key. Each key id stays.

A key that already has that list is left alone. A revoked key is left alone. A second call returns `updated: 0` once those keys match. The caller repeats the request when more than 50 keys remain.
