# Running workflows can be paused together

Pausing one workflow stops new runs and keeps the id, the steps, and every run already stored. An incident can leave many of them able to start, and pausing each row is the wrong tool. `POST /workflows/pause` takes a limit from 1 to 50, reads the oldest workflows that are still running, and uses the same pause as a single workflow. Each workflow id stays. A run that has already started is left on its queues.

A workflow that is already paused is left alone. A deleted workflow is left alone. A second pause of one workflow still returns `409` `WORKFLOW_PAUSED` on the single route. The batch skips that case. A second batch returns `paused: 0` when nothing is still running. The monthly allowance does not change, because no job is created. The caller repeats the request when more than 50 workflows remain.
