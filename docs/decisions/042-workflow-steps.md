# Replacing workflow steps keeps the workflow

A tree should be fixable without throwing away the workflow and its runs. `PATCH /workflows/:workflowId` accepts `steps` and replaces the definition on the same record. The id and pause state stay.

The next run uses the new tree. A run that already started keeps the steps and job ids it began with, because those jobs were created from the definition at the time.

`steps` must be a tree of 2 to 8 steps. A shorter list, a longer list, or a graph that is not a tree returns `400` `VALIDATION_ERROR`. An unknown queue returns `404` `QUEUE_NOT_FOUND`. An empty body still returns `400` `VALIDATION_ERROR`.

The SDK method is `workflows.update` with a `steps` field.
