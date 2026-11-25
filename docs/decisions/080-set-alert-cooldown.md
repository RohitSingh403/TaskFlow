# The oldest alert rules can share one cooldown

A cooldown is how long a rule waits after it opens an alert before it can open another. Changing it on one rule keeps the rule id, the name, the threshold, and any silence. When several rules should wait the same length of time, editing each row is the wrong tool. `POST /alerts/rules/cooldown` takes a cooldown from 1 minute to 24 hours and a limit from 1 to 50, reads the oldest rules, and uses the same cooldown change as a single rule. Each rule id stays.

A rule that already has that cooldown is left alone. A paused rule is included. A silenced rule is included, and the silence stays. An offline-worker rule is included. A deleted rule is left alone. A second call returns `updated: 0` once those rules match. The caller repeats the request when more than 50 rules remain.
