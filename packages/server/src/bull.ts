import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

let connection: ConnectionOptions | null = null;
let prefix = "taskflow";
const queues = new Map<string, Queue>();

export function configureBull(options: ConnectionOptions, queuePrefix = "taskflow") {
  connection = options;
  prefix = queuePrefix;
}

export function getBullConnection(): ConnectionOptions {
  if (!connection) throw new Error("BullMQ connection is not configured");
  return connection;
}

export function getBullPrefix(): string {
  return prefix;
}

export function getBullQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, { connection: getBullConnection(), prefix });
  queues.set(name, queue);
  return queue;
}

export async function closeBullQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export interface EnqueueInput {
  queueName: string;
  jobName: string;
  jobId: string;
  data: Record<string, unknown>;
  options: JobsOptions;
}

export async function enqueueJob(input: EnqueueInput) {
  const queue = getBullQueue(input.queueName);
  try {
    return await queue.add(input.jobName, input.data, { ...input.options, jobId: input.jobId });
  } catch (error) {
    const existing = await queue.getJob(input.jobId);
    if (existing) return existing;
    throw error;
  }
}
