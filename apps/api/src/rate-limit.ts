import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "./config.js";
import { getPublisher } from "./infrastructure.js";

function store(prefix: string) {
  return new RedisStore({
    prefix: `taskflow:rl:${prefix}:`,
    sendCommand: (...args: string[]) => {
      const [command, ...rest] = args;
      return getPublisher().call(command ?? "PING", ...rest) as Promise<number>;
    },
  });
}

function limiter(prefix: string, limit: number, windowMs: number, message: string) {
  return rateLimit({
    windowMs,
    limit: env.NODE_ENV === "test" ? Math.max(limit, 5_000) : limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: store(prefix),
    message: {
      success: false,
      error: { code: "RATE_LIMITED", message },
    },
  });
}

export const authLimiter = limiter("auth", 30, 15 * 60 * 1000, "Too many authentication attempts. Try again later.");
export const refreshLimiter = limiter("refresh", 300, 15 * 60 * 1000, "Too many session refreshes. Try again later.");
export const writeLimiter = limiter("write", 120, 60 * 1000, "Too many write requests. Try again shortly.");
export const readLimiter = limiter("read", 600, 60 * 1000, "Too many requests. Try again shortly.");
