// In-memory sliding-window rate limiter keyed by client IP.
// NOTE: state lives in a module-level Map, so this only works correctly on a
// single instance — a production multi-instance deployment (multiple
// serverless invocations, multiple pods, etc.) needs a shared store (e.g.
// Redis/Upstash) instead.

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix ms timestamp when the current window resets. */
  resetAt: number;
}

// key -> timestamps (ms) of requests still inside the current window.
const buckets = new Map<string, number[]>();

/** Best-effort client IP extraction from common proxy headers. */
function getClientIp(request: Request): string {
  const headers = request.headers;
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]!.trim();
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Sliding-window rate limit check for `request`. Call once per request;
 * returns whether it's allowed plus bookkeeping info you can surface as
 * `X-RateLimit-*` response headers.
 */
export function rateLimit(
  request: Request,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const key = getClientIp(request);
  const now = Date.now();
  const windowStart = now - windowMs;

  const timestamps = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= limit) {
    buckets.set(key, timestamps);
    return {
      success: false,
      limit,
      remaining: 0,
      resetAt: timestamps[0]! + windowMs,
    };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);

  return {
    success: true,
    limit,
    remaining: limit - timestamps.length,
    resetAt: now + windowMs,
  };
}
