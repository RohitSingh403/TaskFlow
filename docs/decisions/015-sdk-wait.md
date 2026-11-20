# The SDK can wait, and it retries only a safe call

`jobs.create` still returns when the API accepts the job. Execution stays on the worker. `jobs.wait` is a separate call that polls `GET /jobs/:id` until the status is completed, failed, or cancelled, then returns that record. A failed job is a result, not a thrown error. The thrown error is `JOB_WAIT_TIMEOUT`, when the deadline passes while the job is still waiting, delayed, or active. The default deadline is 30 seconds. The client does not open Socket.IO.

A read retries a network error and HTTP 408, 429, 500, 502, 503, and 504. The default is two retries. `jobs.create` uses that same policy only when the caller set `idempotencyKey`, because the API returns the original job for that key. A create without a key is sent once. A second automatic attempt could insert a second job if the first request was accepted and the response was lost. Pause, cancel, webhook registration, and the other writes are also sent once.
