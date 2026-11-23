# Paused workflows can be resumed together

Resuming one workflow accepts new runs again and keeps the id, the steps, and every run already stored. After an incident, many workflows can be paused, and resuming each row is the wrong tool. `POST /workflows/resume` takes a limit from 1 to 50, reads the oldest paused workflows, and uses the same resume as a single workflow. Each workflow id stays. A run that has already started is left on its queues.

A workflow that is already running is left alone. A deleted workflow is left alone. A second resume of one workflow still returns `409` `WORKFLOW_NOT_PAUSED` on the single route. The batch skips that case. A second batch returns `resumed: 0` when nothing is still paused. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 workflows remain.
