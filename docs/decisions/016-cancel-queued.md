# Queued jobs can be cancelled together

A waiting or delayed job can already be cancelled one at a time. A bad submission can leave dozens of them on a queue, and cancelling each row is the wrong tool. `POST /jobs/cancel-queued` takes an optional queue and a limit from 1 to 50, reads the oldest waiting and delayed records, and uses the same cancel as a single job. Each removed job is marked `cancelled`. An active job is skipped. The caller repeats the request when more than 50 remain.

Jobs that belong to a workflow run are excluded. A workflow step is part of a tree, and removing it from this list would leave the run waiting on a record that no longer exists. Those steps are cancelled from the job itself.

The monthly allowance is not refunded. The job was already created.
