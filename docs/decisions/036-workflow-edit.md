# Editing a workflow keeps its id

A workflow that already has runs should not be replaced to fix its name. `PATCH /workflows/:workflowId` changes the name or description. The workflow id, the step list, and the runs already stored against that id stay.

The step list is not part of this update. A body that includes steps is accepted only for the name and description fields, and the stored steps are left as they are. A name shorter than 2 characters, or a body with neither field, returns `400` `VALIDATION_ERROR`. A name already used by another workflow in the project returns `409` `WORKFLOW_EXISTS`.

The audit entry records the previous name and description when those values change. The SDK method is `workflows.update`.
