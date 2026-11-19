import { logger } from "@taskflow/server";
import mongoose from "mongoose";
import { env } from "./config.js";
import { startWorkerRuntime } from "./runtime.js";

const runtime = await startWorkerRuntime({
  mongoUri: env.MONGODB_URI,
  redisUrl: env.REDIS_URL,
  bullPrefix: env.BULL_PREFIX,
  workerId: env.WORKER_ID,
  pollMs: env.WORKER_POLL_MS,
  lockDurationMs: env.WORKER_LOCK_DURATION_MS,
  stalledIntervalMs: env.WORKER_STALLED_INTERVAL_MS,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, workerId: runtime.workerId }, "Worker shutting down");
  await runtime.stop();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
