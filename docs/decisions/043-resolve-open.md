# Resolving open alerts in a batch

An incident can open more alerts than an operator wants to click one by one. `POST /alerts/resolve-open` marks the oldest open alerts resolved. Each alert keeps its id.

The body takes an optional rule id and a limit from 1 to 50. The default limit is 20. Alerts are chosen by the earliest `createdAt`. A resolved alert is not selected. A second call returns an empty list. An unknown rule returns `404` `ALERT_NOT_FOUND`.

The SDK method is `alerts.resolveOpen`.
