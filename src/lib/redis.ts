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

/** How long to wait for the connection before calling Redis unavailable. */
const READY_TIMEOUT_MS = 2000;

/** Shared across concurrent callers so a burst of requests waits once, not N times. */
let readyPromise: Promise<boolean> | null = null;

/**
 * Resolves true once the connection is usable.
 *
 * `lazyConnect` + `enableOfflineQueue: false` means the FIRST command after a
 * cold start is rejected outright ("Stream isn't writeable") instead of
 * waiting for the socket — the connection hasn't been opened yet, and there's
 * no queue to hold the command. For a caller that fails closed on error (see
 * session-revocation) that read as "Redis is down", so every app restart
 * bounced whoever happened to be mid-request back to the login screen.
 *
 * Awaiting readiness first turns that transient into a short wait. It does NOT
 * soften the fail-closed behaviour: a genuinely unreachable Redis still ends
 * up false here, and the caller still treats the session as revoked.
 */
export function redisReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  if (redis.status === "ready") return Promise.resolve(true);
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      redis.off("ready", onReady);
      readyPromise = null;
      resolve(value);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    redis.on("ready", onReady);
    // "wait" is lazyConnect's initial state; "end" follows a closed connection.
    // Any other state means a connect attempt is already in flight.
    if (redis.status === "wait" || redis.status === "end") {
      redis.connect().catch(() => {
        // Already connecting, or the attempt failed — either way the "ready"
        // listener or the timeout decides the outcome.
      });
    }
    // Re-check: the status can flip between the guard above and the listener
    // being attached, which would otherwise leave us waiting for an event
    // that has already fired.
    if (redis.status === "ready") finish(true);
  });

  return readyPromise;
}
