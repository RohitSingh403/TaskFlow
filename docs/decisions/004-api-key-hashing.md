# API keys use SHA-256

API keys are 256 bits from a CSPRNG, prefixed `tf_live_`. The database stores SHA-256 of the full secret plus a display prefix. Argon2 is used for passwords because those are low-entropy human secrets. A high-entropy key does not need a password hash, and Argon2 on every API request would add latency without adding meaningful protection against offline guessing of a 256-bit token.

The raw secret is returned once at creation and is not written to logs. Refresh tokens use the same SHA-256 treatment and can be revoked.
