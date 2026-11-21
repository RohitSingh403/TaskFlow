# Rotating a webhook secret replaces the value used to sign

The full signing secret is shown once, on create and on rotate. `POST /webhooks/:webhookId/rotate` stores a new secret and a new prefix. Later reads return the prefix only.

A delivery that has not been sent yet is signed with the secret stored at send time. After a rotation, that is the new secret. The previous secret no longer matches. A paused endpoint can still be rotated, so the secret can be replaced before the endpoint is enabled again.
