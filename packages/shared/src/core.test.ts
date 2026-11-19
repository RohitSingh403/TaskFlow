import { describe, expect, it } from "vitest";
import { describeRetrySchedule, retryDelayMs } from "./backoff.js";
import { HANDLER_EXAMPLES, handlerSchemas, simulationDecision } from "./handlers.js";
import { priorityToBull } from "./priority.js";
import { findUnsafeKey, redact } from "./redact.js";
import { deriveWorkerHealth, mapBullState, shouldApplyJobStatus } from "./status.js";
import { summarizeDurations } from "./stats.js";

describe("job status mapping", () => {
  it("maps BullMQ states onto the application lifecycle", () => {
    expect(mapBullState("prioritized")).toBe("waiting");
    expect(mapBullState("waiting-children")).toBe("waiting");
    expect(mapBullState("delayed")).toBe("delayed");
    expect(mapBullState("active")).toBe("active");
    expect(mapBullState("completed")).toBe("completed");
    expect(mapBullState("failed")).toBe("failed");
  });

  it("refuses to move a terminal job backwards unless forced", () => {
    expect(shouldApplyJobStatus("completed", "waiting")).toBe(false);
    expect(shouldApplyJobStatus("failed", "active")).toBe(false);
    expect(shouldApplyJobStatus("failed", "waiting", true)).toBe(true);
    expect(shouldApplyJobStatus("active", "failed")).toBe(true);
  });

  it("derives worker health from heartbeat age", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    expect(deriveWorkerHealth(new Date(now - 5_000), now)).toBe("online");
    expect(deriveWorkerHealth(new Date(now - 20_000), now)).toBe("unhealthy");
    expect(deriveWorkerHealth(new Date(now - 60_000), now)).toBe("offline");
    expect(deriveWorkerHealth(new Date(now - 1_000), now, true)).toBe("offline");
  });
});

describe("retry schedule", () => {
  it("matches the documented exponential example", () => {
    expect(describeRetrySchedule("exponential", 5_000, 4)).toEqual([
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 5_000 },
      { attempt: 3, delayMs: 10_000 },
      { attempt: 4, delayMs: 20_000 },
    ]);
    expect(retryDelayMs("fixed", 5_000, 4)).toBe(5_000);
  });
});

describe("priority", () => {
  it("gives the high label the strongest BullMQ priority", () => {
    expect(priorityToBull("high")).toBeLessThan(priorityToBull("medium"));
    expect(priorityToBull("medium")).toBeLessThan(priorityToBull("low"));
  });
});

describe("redaction and payload safety", () => {
  it("redacts secret-bearing fields and rejects prototype keys", () => {
    expect(redact({ password: "hunter2", subject: "Hello", nested: { apiKey: "abc" } })).toEqual({
      password: "[REDACTED]",
      subject: "Hello",
      nested: { apiKey: "[REDACTED]" },
    });
    expect(findUnsafeKey({ profile: { constructor: { bad: true } } })).toBe("payload.profile.constructor");
  });
});

describe("handlers", () => {
  it("accepts the documented examples and blocks production simulation", () => {
    for (const [name, example] of Object.entries(HANDLER_EXAMPLES)) {
      expect(handlerSchemas[name as keyof typeof handlerSchemas].safeParse(example).success).toBe(true);
    }
    expect(simulationDecision("production", { _simulate: { delayMs: 10 } }).ok).toBe(false);
    expect(simulationDecision("development", { _simulate: { delayMs: 10 } }).ok).toBe(true);
  });
});

describe("duration summary", () => {
  it("computes average and percentiles from a sample", () => {
    const summary = summarizeDurations([10, 20, 30, 40, 100]);
    expect(summary.count).toBe(5);
    expect(summary.avg).toBe(40);
    expect(summary.p50).toBe(30);
    expect(summary.p99).toBe(100);
  });
});
