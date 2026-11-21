# The jobs list can be limited to when the job was created

`GET /jobs` already accepted `from` and `to`, and the jobs page never sent them. An operator looking for yesterday's work had to page through everything newer. The page now sends those query parameters, and the same window is what `jobs.list` accepts.

Both values are ISO datetimes compared with `createdAt`. Leave `from` out to include every older job. Leave `to` out to include every newer job. The Last 24 hours and Last 7 days controls set `from` and clear `to`. All time clears both.

A `from` later than `to` is a `400` `VALIDATION_ERROR`. The window only changes which records the list returns. It does not cancel, retry, or delete the jobs outside it.
