import { JOB_STATUSES, type JobStatus } from "./constants.js";

const TERMINAL = new Set<JobStatus>(["completed", "failed", "cancelled"]);

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * BullMQ is the execution source of truth. These names are the queue-engine
 * states we mirror into the application record.
 */
export function mapBullState(state: string): JobStatus {
  switch (state) {
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "delayed":
      return "delayed";
    case "waiting":
    case "waiting-children":
    case "prioritized":
    case "paused":
      return "waiting";
    default:
      return "waiting";
  }
}

/**
 * Ignore late events that would move a terminal job backwards.
 * Manual retry passes `force` so a failed job can return to waiting.
 */
export function shouldApplyJobStatus(
  current: JobStatus,
  next: JobStatus,
  force = false,
): boolean {
  if (force || current === next) return true;
  if (isTerminalStatus(current) && !isTerminalStatus(next)) return false;
  return true;
}

export type WorkerHealth = "online" | "unhealthy" | "offline";

export function deriveWorkerHealth(
  lastHeartbeatAt: Date | string | null | undefined,
  now = Date.now(),
  stopped = false,
): WorkerHealth {
  if (stopped || !lastHeartbeatAt) return "offline";
  const age = now - new Date(lastHeartbeatAt).getTime();
  if (age < 15_000) return "online";
  if (age < 45_000) return "unhealthy";
  return "offline";
}
