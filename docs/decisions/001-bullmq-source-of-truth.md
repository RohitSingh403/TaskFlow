# BullMQ is the execution source of truth

Queue membership, delays, retries, locks, and pause live in Redis through BullMQ. MongoDB mirrors that state for queries the dashboard needs: filters, attempt history, duration, and logs.

The mirror can lag. Worker events update it, and a sweep copies BullMQ state onto quiet records. Code that decides whether a job may run asks BullMQ. Code that renders history reads MongoDB.

Application status names are centralized in `packages/shared/src/status.ts` so the API and worker do not invent a second state machine.
