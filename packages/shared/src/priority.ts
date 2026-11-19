import type { PriorityLabel } from "./constants.js";

/**
 * BullMQ treats a smaller positive integer as a higher priority.
 * Priority 0 means "no priority", so every labeled job uses 1 or above.
 */
const BULL_PRIORITY: Record<PriorityLabel, number> = {
  high: 1,
  medium: 5,
  low: 10,
};

export function priorityToBull(label: PriorityLabel): number {
  return BULL_PRIORITY[label];
}

export function bullToPriority(value: number): PriorityLabel {
  if (value <= 2) return "high";
  if (value <= 7) return "medium";
  return "low";
}
