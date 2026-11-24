# The oldest workflows can be started together

Starting one workflow creates one run and one job per step. A paused workflow refuses that start. When several workflows need a run at the same time, opening each one is the wrong tool. `POST /workflows/runs` takes a limit from 1 to 50, reads the oldest workflows that can still accept a run, and uses the same start as a single workflow. Each workflow id stays.

A paused workflow is left alone, and so is a deleted workflow. Each run is new, so a second batch starts another run for every workflow that can still accept one. The steps count toward the monthly allowance. The allowance is checked for the whole batch before any run is created. A queue that is missing or at its waiting-job ceiling is skipped, and the other workflows still start. The caller repeats the request when more than 50 workflows remain.
