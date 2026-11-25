# The oldest expiring API keys can be extended together

Changing one key's expiry keeps the key id, the prefix, and the secret. An expired key can be extended, and that same secret works again. A key that never expires stays that way until someone sets a date. When several expiring keys should move forward, editing each row is the wrong tool. `POST /api-keys/extend` takes a day count from 1 to 365 and a limit from 1 to 50, reads the oldest keys that already expire, and uses the same expiry change as a single key. Each key id stays.

A key that never expires is left alone. A revoked key is left alone. The new date is measured from the call, so a second call extends those keys again. The caller repeats the request when more than 50 expiring keys remain.
