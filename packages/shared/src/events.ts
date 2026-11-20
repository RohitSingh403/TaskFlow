import type { AlertType, JobStatus } from "./constants.js";
import type { WorkerHealth } from "./status.js";

export interface JobUpdatedEvent {
  type: "job.updated";
  projectId: string;
  data: {
    jobId: string;
    status: JobStatus;
    queue: string;
    durationMs?: number;
  };
}

export interface QueueUpdatedEvent {
  type: "queue.updated";
  projectId: string;
  data: {
    queueId: string;
    isPaused: boolean;
  };
}

export interface WorkerUpdatedEvent {
  type: "worker.updated";
  projectIds: string[];
  data: {
    workerId: string;
    health: WorkerHealth;
  };
}

export interface AlertFiredEvent {
  type: "alert.fired";
  projectId: string;
  data: {
    alertId: string;
    ruleId: string;
    alertType: AlertType;
  };
}

export type RealtimeEvent = JobUpdatedEvent | QueueUpdatedEvent | WorkerUpdatedEvent | AlertFiredEvent;
