import { describe, expect, it } from "vitest";
import { CronError, nextCronOccurrence } from "./cron.js";

describe("nextCronOccurrence", () => {
  it("returns the following midnight in UTC", () => {
    const after = new Date("2026-10-30T00:00:00.000Z");
    expect(nextCronOccurrence("0 0 * * *", "UTC", after).toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("uses the schedule time zone", () => {
    const after = new Date("2026-10-30T00:00:00.000Z");
    const next = nextCronOccurrence("30 9 * * *", "Asia/Kolkata", after);
    expect(next.toISOString()).toBe("2026-10-30T04:00:00.000Z");
  });

  it("rejects seconds and unknown zones", () => {
    expect(() => nextCronOccurrence("* * * * * *", "UTC", new Date())).toThrow(CronError);
    expect(() => nextCronOccurrence("0 0 * * *", "Not/AZone", new Date())).toThrow(CronError);
    expect(() => nextCronOccurrence("99 0 * * *", "UTC", new Date())).toThrow(CronError);
  });
});
