/**
 * Redis-backed rate limiting for abuse / DoS ceilings.
 *
 * `rateLimit` is a fixed-window counter (INCR + EXPIRE) — cheap and adequate for
 * "no more than N per window" caps on expensive endpoints (AI inference, bulk
 * email, public webhooks). `tokenBucket` allows short bursts on top of a steady
 * refill rate when a hard window is too coarse.
 *
 * Both fail OPEN by default (allow on Redis error) but log loudly, so a Redis
 * blip degrades to "unmetered" rather than "outage". Pass `failOpen: false` on
 * paths where availability matters less than the cap (e.g. auth-adjacent abuse).
 */
import { redis } from "./redis";
import { logger } from "./logger";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window (>= 0). */
  remaining: number;
  /** Configured ceiling for the window. */
  limit: number;
  /** Seconds until the window resets / a token frees up. */
  resetSec: number;
}

export interface RateLimitOptions {
  /** Caller-namespaced identity, e.g. `ai-assist:${sub}` or `webhook:${ip}`. */
  key: string;
  /** Max permitted hits per window. */
  limit: number;
  /** Window length in seconds (use 86400 for a daily cap). */
  windowSec: number;
  /** On Redis failure: allow (default) or deny. */
  failOpen?: boolean;
}

/**
 * Fixed-window counter. The first hit in a window sets the TTL; the window slides
 * forward every `windowSec`. Returns `allowed=false` once the count exceeds `limit`.
 */
export async function rateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const { key, limit, windowSec, failOpen = true } = opts;
  const redisKey = `rl:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSec);
    }
    let ttl = await redis.ttl(redisKey);
    if (ttl < 0) {
      // Key exists without a TTL (e.g. EXPIRE lost to a crash) — re-arm it.
      await redis.expire(redisKey, windowSec);
      ttl = windowSec;
    }
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetSec: ttl,
    };
  } catch (err) {
    logger.warn({ err, key }, "rate-limit: Redis unavailable — bypassing limit");
    return { allowed: failOpen, remaining: failOpen ? limit : 0, limit, resetSec: windowSec };
  }
}

export interface TokenBucketOptions {
  key: string;
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
  /** Tokens to consume for this call (default 1). */
  cost?: number;
  failOpen?: boolean;
}

/**
 * Token bucket implemented with a small Lua script for atomicity. Allows bursts
 * up to `capacity` while enforcing a sustained rate of `refillPerSec`.
 *
 * NOTE: uses `redis.call('TIME')` for the clock, so it does not depend on the
 * caller's wall clock and is safe across replicas.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(redis.call('TIME')[1])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local delta = math.max(0, now - ts)
tokens = math.min(capacity, tokens + delta * refill)
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- keep the key only as long as it could take to refill from empty
local ttl = math.ceil(capacity / refill) + 1
redis.call('EXPIRE', key, ttl)
return { allowed, tokens }
`;

export async function tokenBucket(opts: TokenBucketOptions): Promise<RateLimitResult> {
  const { key, capacity, refillPerSec, cost = 1, failOpen = true } = opts;
  const redisKey = `tb:${key}`;
  try {
    const [allowed, tokens] = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      redisKey,
      String(capacity),
      String(refillPerSec),
      String(cost),
    )) as [number, number];
    const remaining = Math.floor(tokens);
    return {
      allowed: allowed === 1,
      remaining,
      limit: capacity,
      resetSec: allowed === 1 ? 0 : Math.ceil((cost - tokens) / refillPerSec),
    };
  } catch (err) {
    logger.warn({ err, key }, "token-bucket: Redis unavailable — bypassing limit");
    return { allowed: failOpen, remaining: failOpen ? capacity : 0, limit: capacity, resetSec: 1 };
  }
}

/** Standard 429 response with Retry-After + rate-limit headers. */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfterSec: result.resetSec }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, result.resetSec)),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
