# Send again queues the same webhook delivery

A failed or already accepted delivery sometimes needs to be posted again after the receiver is fixed. Creating a second delivery would give the receiver a new id for the same event, and the unique record for a webhook, event, and resource would reject it. `POST /webhooks/:webhookId/deliveries/:deliveryId/redeliver` queues the existing delivery.

The body and the delivery id stay the same. Earlier attempts remain on the record. The signature is computed with the current secret, so a rotation applies to the new post. A delivery that is still pending, or whose queue job is active, returns `409` `DELIVERY_PENDING`. A disabled or deleted endpoint returns `409` `WEBHOOK_DISABLED`. The queue job from the previous run is removed before the new one is added, so the old failure does not block the new post.
