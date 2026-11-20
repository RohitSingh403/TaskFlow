# Workflows use BullMQ flows, and flows are trees

A workflow run should not invent a second scheduler for dependencies. BullMQ already keeps a parent job in `waiting-children` until its children complete, and `FlowProducer.add` writes the whole tree in one operation.

That model has a constraint: a job has one parent. A step may wait for several children, which is a fan-in. A step may not be the child of two parents, which would be a shared dependency or a diamond. TaskFlow rejects that graph at creation time instead of copying a job so it can appear twice.

The final step is the flow root. Earlier steps are its children, recursively. Job records are written first with the ids the flow will use. If Redis rejects the flow, those records are marked failed and the run is failed. A failed child is retried through the existing job retry. When that child completes, BullMQ releases the parent.
