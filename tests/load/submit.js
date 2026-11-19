// k6 sketch. This file has not been executed in this repository, so it is not a benchmark result.
// Run it yourself against a deployed API key and record the hardware, duration, and handler work.
//
// k6 run -e BASE_URL=http://127.0.0.1:4000 -e PROJECT_ID=proj_... -e API_KEY=tf_live_... tests/load/submit.js

import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 10,
  duration: "30s",
};

export default function () {
  const response = http.post(
    `${__ENV.BASE_URL}/api/v1/projects/${__ENV.PROJECT_ID}/jobs`,
    JSON.stringify({
      queue: "emails",
      name: "send-email",
      payload: {
        to: "user@example.com",
        subject: "Load",
        body: "Synthetic load-test message",
      },
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `load-${__VU}-${__ITER}`,
      },
    },
  );
  check(response, { "accepted": (result) => result.status === 201 || result.status === 200 });
  sleep(0.1);
}
