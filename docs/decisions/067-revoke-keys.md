# The oldest API keys can be revoked together

Revoking one key stops that secret and keeps the key id, the prefix, and the stored hash. An expired key can still be revoked. When several keys should stop, revoking each row is the wrong tool. `POST /api-keys/revoke` takes a limit from 1 to 50, reads the oldest keys that are still active or expired, and uses the same revoke as a single key. Each key id stays.

A key that is already revoked is left alone. A second call returns `revoked: 0` once those keys are revoked. The owner is the only person who can do this, and an API key cannot call it. The caller repeats the request when more than 50 keys remain.
