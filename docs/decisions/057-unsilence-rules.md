# Silenced rules can start checking again together

Clearing one silence lets that rule open alerts again and keeps the rule id. The rule stays enabled. After an incident, many rules can be silenced, and clearing each row is the wrong tool. `POST /alerts/rules/unsilence` takes a limit from 1 to 50, reads the oldest rules whose silence is still in the future, and uses the same clear as a single rule. Each rule id stays.

A rule that is already checking is left alone. A silence that has already ended is left alone. A deleted rule is left alone. A second batch returns `unsilenced: 0` when nothing is still silenced. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 rules remain.
