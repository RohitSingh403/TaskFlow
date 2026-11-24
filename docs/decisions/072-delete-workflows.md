# The oldest workflows can be deleted together

Deleting one workflow keeps the workflow id, the name, the steps, and the pause state. A paused workflow can still be deleted. A run that already started stays. When several workflows should leave the list, deleting each row is the wrong tool. `POST /workflows/delete` takes a limit from 1 to 50, reads the oldest workflows that are still present, and uses the same delete as a single workflow. Each workflow id stays.

A workflow that is already deleted is left alone. A second call returns `deleted: 0` once those workflows are deleted. The caller repeats the request when more than 50 workflows remain.
