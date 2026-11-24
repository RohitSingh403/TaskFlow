# The oldest alert rules can be deleted together

Deleting one rule keeps the rule id, the name, the type, the queue, the threshold, and any silence. The rule is disabled, so the scheduler stops checking it. An open alert stays. A paused rule and a silenced rule can still be deleted. When several rules should leave the list, deleting each row is the wrong tool. `POST /alerts/rules/delete` takes a limit from 1 to 50, reads the oldest rules that are still present, and uses the same delete as a single rule. Each rule id stays.

A rule that is already deleted is left alone. A second call returns `deleted: 0` once those rules are deleted. The caller repeats the request when more than 50 rules remain.
