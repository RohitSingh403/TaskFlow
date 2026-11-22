# Editing an alert rule keeps its id and silence

Changing a threshold should not require a new rule. `PATCH /alerts/rules/:ruleId` updates the same record. The type, queue, silence, and last opened time stay.

An offline-worker rule has no threshold. A failure-rate threshold is a percent from 1 to 100. A long-running threshold is at least 10 seconds. A name that another rule already uses returns `409` `ALERT_EXISTS`.
