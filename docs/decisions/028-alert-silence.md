# Silence skips an alert rule until a chosen time

Pausing a rule turns it off until someone enables it again. During an incident, an operator often wants the rule back on its own. `POST /alerts/rules/:ruleId/silence` sets `silencedUntil` to now plus `durationMs`. The scheduler skips that rule until the time passes. The rule stays enabled, and its cooldown is unchanged.

`durationMs` is from 5 minutes to 7 days. A later silence replaces the previous time. `POST /unsilence` clears it. A silenced rule does not open an alert and does not refresh `lastTriggeredAt`.
