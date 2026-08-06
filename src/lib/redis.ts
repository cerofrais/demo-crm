import Redis from "ioredis";
import { env } from "./env";

/**
 * Redis singleton — sessions support, JWKS cache, and rate-limit counters.
 * `lazyConnect` so importing this module never blocks if Redis is down at build
 * time; the first command triggers the connection.
 */
const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });

if (env.NODE_ENV !== "production") globalForRedis.redis = redis;
