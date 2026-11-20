import { createRequire } from "node:module";

const { parseExpression } = createRequire(import.meta.url)("cron-parser") as {
  parseExpression: (
    expression: string,
    options?: { currentDate?: Date; tz?: string },
  ) => { next: () => { toDate: () => Date } };
};

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export function assertTimeZone(timeZone: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new CronError("Use an IANA time zone such as UTC or Asia/Kolkata");
  }
}

export function assertCronPattern(pattern: string) {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError("Use a five-field cron pattern: minute hour day month weekday");
  }
  try {
    parseExpression(pattern, { currentDate: new Date(), tz: "UTC" });
  } catch {
    throw new CronError("Cron pattern is not valid");
  }
}

export function nextCronOccurrence(pattern: string, timeZone: string, after: Date): Date {
  assertCronPattern(pattern);
  assertTimeZone(timeZone);
  const interval = parseExpression(pattern, { currentDate: after, tz: timeZone });
  let next = interval.next().toDate();
  if (next.getTime() <= after.getTime()) next = interval.next().toDate();
  return next;
}
