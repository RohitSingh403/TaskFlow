# A project has one owner and optional members

The owner creates the project. Another person can operate it only after that owner adds an account that already exists. The invite is an email lookup. TaskFlow does not send mail, and it does not keep a pending invitation for an address that has no account.

A member can use the project: jobs, queues, schedules, workflows, alerts, webhooks, workers, logs, and analytics. The owner keeps settings, API keys, membership changes, and deletion. A member who tries one of those receives `403`. An account that is neither the owner nor a member still receives `404`.

Leaving or being removed drops that person's access. It does not revoke the project's API keys, because a key belongs to the project. The owner cannot leave. The owner can transfer the project to a current member; that handoff is described in `013-ownership-transfer.md`. A project can have 20 members besides the owner.
