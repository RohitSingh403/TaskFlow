import type { BackoffType } from "./constants.js";

/**
 * Delay before a given attempt. Attempt 1 runs immediately.
 * Later attempts follow BullMQ's built-in strategies:
 * - fixed: the same delay every retry
 * - exponential: base * 2^(retryIndex - 1)
 *
 * Example with a 5s exponential base: immediate, 5s, 10s, 20s.
 */
export function retryDelayMs(type: BackoffType, baseDelayMs: number, attempt: number): number {
  if (attempt <= 1) return 0;
  const retryIndex = attempt - 1;
  if (type === "fixed") return baseDelayMs;
  return Math.round(baseDelayMs * 2 ** (retryIndex - 1));
}

export function describeRetrySchedule(
  type: BackoffType,
  baseDelayMs: number,
  maxAttempts: number,
): { attempt: number; delayMs: number }[] {
  return Array.from({ length: maxAttempts }, (_, index) => ({
    attempt: index + 1,
    delayMs: retryDelayMs(type, baseDelayMs, index + 1),
  }));
}
