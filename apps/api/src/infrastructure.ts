import { configureBull, createRedis, ensureIndexes, logger, redisOptionsFromUrl } from "@taskflow/server";
import { EVENTS_CHANNEL, type RealtimeEvent } from "@taskflow/shared";
import mongoose from "mongoose";
import type { Server as SocketServer } from "socket.io";
import { env } from "./config.js";

let publisher = createRedis(env.REDIS_URL);
let subscriber = createRedis(env.REDIS_URL);
let subscriberReady = false;

export function getPublisher() {
  return publisher;
}

export async function connectInfrastructure() {
  configureBull(redisOptionsFromUrl(env.REDIS_URL), env.BULL_PREFIX);
  await connectWithRetry(async () => {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5_000,
      maxPoolSize: 20,
    });
  }, "MongoDB");
  await ensureIndexes();
  await connectWithRetry(async () => {
    if (publisher.status === "end" || publisher.status === "close") {
      publisher = createRedis(env.REDIS_URL);
    }
    await publisher.ping();
  }, "Redis");
}

export function startEventBridge(io: SocketServer) {
  if (subscriberReady) return;
  subscriber.subscribe(EVENTS_CHANNEL).catch((error) => {
    logger.error({ err: error }, "Failed to subscribe to job events");
  });
  subscriber.on("message", (_channel, message) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message) as RealtimeEvent;
    } catch {
      return;
    }
    if (event.type === "worker.updated") {
      for (const projectId of event.projectIds) {
        io.to(`project:${projectId}`).emit(event.type, event.data);
      }
      return;
    }
    io.to(`project:${event.projectId}`).emit(event.type, event.data);
  });
  subscriberReady = true;
}

export async function publish(event: RealtimeEvent) {
  await publisher.publish(EVENTS_CHANNEL, JSON.stringify(event));
}

export async function disconnectInfrastructure() {
  subscriberReady = false;
  subscriber.removeAllListeners("message");
  await Promise.allSettled([publisher.quit(), subscriber.quit(), mongoose.disconnect()]);
}

async function connectWithRetry(operation: () => Promise<unknown>, label: string) {
  let last: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await operation();
      logger.info({ attempt }, `${label} connected`);
      return;
    } catch (error) {
      last = error;
      logger.warn({ err: error, attempt, label }, "Infrastructure connection failed");
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw last;
}
