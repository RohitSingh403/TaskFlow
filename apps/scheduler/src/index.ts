import { writeFile } from "node:fs/promises";
import {
  closeBullQueues,
  configureBull,
  createRedis,
  ensureIndexes,
  logger,
  evaluateAlerts,
  produceDueSchedules,
  randomToken,
  redisOptionsFromUrl,
} from "@taskflow/server";
import { EVENTS_CHANNEL } from "@taskflow/shared";
import mongoose from "mongoose";
import { env } from "./config.js";

configureBull(redisOptionsFromUrl(env.REDIS_URL), env.BULL_PREFIX);
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 10 });
await ensureIndexes();

const redis = createRedis(env.REDIS_URL);
const token = randomToken(16);
const lockKey = `${env.BULL_PREFIX}:scheduler:leader`;
const lockTtlMs = Math.max(env.SCHEDULER_POLL_MS * 3, 15_000);
let ticking = false;
let stopped = false;

async function holdLeader() {
  const acquired = await redis.set(lockKey, token, "PX", lockTtlMs, "NX");
  if (acquired === "OK") return true;
  const current = await redis.get(lockKey);
  if (current !== token) return false;
  await redis.pexpire(lockKey, lockTtlMs);
  return true;
}

async function tick() {
  if (stopped || ticking) return;
  ticking = true;
  try {
    const leader = await holdLeader();
    if (!leader) return;
    await writeFile("/tmp/taskflow-scheduler-alive", String(Date.now())).catch(() => undefined);
    const result = await produceDueSchedules(new Date(), async (event) => {
      await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
    });
    if (result.produced > 0) logger.info({ produced: result.produced }, "Scheduler produced jobs");
    const alerts = await evaluateAlerts(new Date());
    for (const alert of alerts) {
      await redis.publish(EVENTS_CHANNEL, JSON.stringify({
      type: "alert.fired",
      projectId: alert.projectId,
      data: { alertId: alert.alertId, ruleId: alert.ruleId, alertType: alert.alertType },
    }));
    }
    if (alerts.length > 0) logger.info({ alerts: alerts.length }, "Scheduler opened alerts");
  } catch (error) {
    logger.error({ err: error }, "Scheduler tick failed");
  } finally {
    ticking = false;
  }
}

await tick();
const poll = setInterval(() => void tick(), env.SCHEDULER_POLL_MS);
logger.info({ pollMs: env.SCHEDULER_POLL_MS }, "TaskFlow scheduler running");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  clearInterval(poll);
  logger.info({ signal }, "Scheduler shutting down");
  await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token);
  await closeBullQueues();
  await redis.quit();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
