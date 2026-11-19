import { Redis, type RedisOptions } from "ioredis";

export function redisOptionsFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const pathDb = parsed.pathname.replace("/", "");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: pathDb ? Number(pathDb) : 0,
    maxRetriesPerRequest: null,
  };
}

export function createRedis(url: string) {
  return new Redis(redisOptionsFromUrl(url));
}
