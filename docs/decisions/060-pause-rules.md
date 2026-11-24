# Enabled alert rules can be paused together

Pausing one rule stops the scheduler from checking it and keeps the rule id. A silence that is already set stays. During an incident, many rules can still be enabled, and pausing each row is the wrong tool. `POST /alerts/rules/pause` takes a limit from 1 to 50, reads the oldest enabled rules, and uses the same pause as a single rule. Each rule id stays.

A rule that is already paused is left alone. A deleted rule is left alone. Silence is a separate skip: pausing a silenced rule turns it off and leaves `silencedUntil` where it is. A second batch returns `paused: 0` when nothing is still enabled. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 rules remain.
