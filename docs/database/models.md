# Data model

MongoDB collections and the indexes that back the access patterns:

| Collection | Index | Why |
| --- | --- | --- |
| users | unique `email` | One account per email |
| projects | `ownerId` | List a user's projects |
| queueconfigs | unique `projectId + name` where `deletedAt` is null | One live name per project |
| jobrecords | unique `publicId` | External id and BullMQ job id |
| jobrecords | `projectId + createdAt` | Recent jobs |
| jobrecords | `projectId + status + createdAt` | Filtered lists |
| jobrecords | unique `projectId + idempotencyKey` when the key is a string | Duplicate submissions |
| jobattempts | unique `jobId + attemptNumber` | One row per attempt |
| workers | unique `workerId` | Heartbeat upsert |
| apikeys | unique `keyHash` | Authentication lookup |
| logs | `timestamp` TTL of 14 days | Retention |
| sideeffects | unique `key` | Idempotent handler receipts |
| schedules | unique `projectId + name` where `deletedAt` is null | One live name per project |
| jobrecords | `projectId + scheduleId + createdAt` | Jobs produced by a schedule |
| workflows | unique `projectId + name` where `deletedAt` is null | One live name per project |
| workflowruns | `workflowId + createdAt` | Recent runs of one definition |
| jobrecords | `workflowRunId` | Steps that belong to one run |
| alertrules | unique `projectId + name` where `deletedAt` is null | One live name per project |
| alertevents | `projectId + status + createdAt` | Open and recent alerts |
| webhooks | `projectId + enabled + deletedAt` | Endpoints that should receive an event |
| webhookdeliveries | unique `webhookId + event + resourceId` | One delivery record per event |
| webhookdeliveries | `projectId + createdAt` | Recent deliveries |
| webhookdeliveries | `status + enqueued + createdAt` | Repair a delivery that was saved and not queued |
| refreshtokens | `expiresAt` TTL | Drop expired sessions |

`passwordHash` and `keyHash` are excluded from normal queries. API responses return a key prefix, never the hash or the secret.

Worker `online`, `unhealthy`, and `offline` are computed from `lastHeartbeatAt` and `stoppedAt` at read time. Thresholds are 15 seconds and 45 seconds.

Job history is not expired. Operators who keep this running should add an archive policy before the collection grows without bound. Logs already expire.
