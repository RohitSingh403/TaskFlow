# Rules that are still checking can be silenced together

Silencing one rule skips it until a chosen time and keeps the rule id. The rule stays enabled. During an incident, many rules can still be checking, and silencing each row is the wrong tool. `POST /alerts/rules/silence` takes the same duration as a single silence and a limit from 1 to 50. It reads the oldest rules whose silence has not started, or whose silence has already ended, and uses the same silence as a single rule. Each rule id stays.

A rule that is already silenced is left alone. A deleted rule is left alone. A second silence of one rule still replaces that rule's time on the single route. The batch does not. A second batch returns `silenced: 0` when every remaining rule is already silenced. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 rules remain.
