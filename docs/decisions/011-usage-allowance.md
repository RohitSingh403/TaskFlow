# Monthly job allowance, without collecting payment

A project needs a ceiling so one tenant cannot create unbounded work. The ceiling is the number of job records created since 00:00 UTC on the first day of the month. The developer plan allows 2,000. The scale plan allows 50,000. The owner changes the plan. TaskFlow does not store a card and does not charge money.

The check runs before a new job is inserted, before a workflow run creates its steps, and before a schedule claims its next tick. A repeated idempotency key returns the original job and does not consume another allowance. A schedule that would pass the allowance moves to its next occurrence and stores the reason, so a restart does not replay that tick.

Two overlapping requests can both observe the same count and both insert. The allowance is a guard, not a lock. The job records remain the count the next request sees.
