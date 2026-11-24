# Waiting workflow runs can be cancelled together

Cancelling one run removes its waiting and delayed steps and keeps the run id. During an incident, many runs can still be waiting, and cancelling each one is the wrong tool. `POST /workflows/runs/cancel` takes a limit from 1 to 50, reads the oldest waiting runs on workflows that still exist, and uses the same cancel as a single run. Each run id stays.

A run that has already finished is left alone. A run that is already cancelled is left alone. A run with an active step is left alone, and that step keeps running. A run whose workflow was deleted is left alone. A second batch returns `cancelled: 0` when nothing is still waiting. The monthly allowance does not change, because no new job is created. The caller repeats the request when more than 50 runs remain.
