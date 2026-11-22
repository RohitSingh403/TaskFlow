# Pausing a workflow stops new runs

Deleting a workflow is the only way to stop operators from starting it, and that hides the definition. `POST /workflows/:workflowId/pause` keeps the workflow id, the steps, and every run already stored. A later `POST /workflows/:workflowId/runs` returns `409` `WORKFLOW_PAUSED` until `POST /workflows/:workflowId/resume`.

A run that has already started is left on its queues. Pause does not cancel waiting or active steps. A second pause returns `409` `WORKFLOW_PAUSED`. Resuming a workflow that is not paused returns `409` `WORKFLOW_NOT_PAUSED`.

The SDK methods are `workflows.pause` and `workflows.resume`.
