# Paused alert rules can be resumed together

Resuming one rule lets the scheduler check it again and keeps the rule id. A silence that is already set stays. After an incident, many rules can still be paused, and enabling each row is the wrong tool. `POST /alerts/rules/resume` takes a limit from 1 to 50, reads the oldest paused rules, and uses the same enable as a single rule. Each rule id stays.

A rule that is already enabled is left alone. A deleted rule is left alone. Silence is a separate skip: resuming a silenced rule turns it back on and leaves `silencedUntil` where it is. The scheduler still skips that rule until the silence ends. A second batch returns `resumed: 0` when nothing is still paused. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 rules remain.
