# Cancelling a workflow run keeps its id

A run that is stuck waiting, or a failed run whose later steps never started, should not have to stay on the queues until retention. `POST /workflows/:workflowId/runs/:runId/cancel` removes each waiting or delayed step with the same rules as cancelling one job. The run id stays, and its status becomes `cancelled`.

An active step is left running. The cancel is refused with `409` `WORKFLOW_RUN_NOT_CANCELLABLE` until that step finishes. A completed run and a second cancel return the same code. Completed and failed steps are not rewritten.

The final step is removed first. Its unprocessed dependencies leave Redis with it, and those records are then marked cancelled. A later worker event does not move a cancelled run back to another status.
