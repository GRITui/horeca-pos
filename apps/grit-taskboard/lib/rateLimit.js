/* Sidekick — lib/rateLimit.js
 *
 * Small fixed-window request limiter for the handful of endpoints that are
 * cheap for an attacker and not free for us: the auth endpoints (login is
 * bounded — api/auth-login.js hashes with the account's STORED
 * password_iters, never attacker-supplied ones, so no request can make us
 * burn unbounded PBKDF2 CPU — but high-volume credential stuffing still
 * costs DB lookups and hash work per attempt), account-creation spam
 * (auth-register*, each a users-table insert), invite brute-forcing
 * (team-join), and the public unauthenticated booking endpoint
 * (booking-request), where a loop can 'hold' every open slot an account
 * has and effectively close its booking page for 15 minutes at a time.
 *
 * HONEST LIMITATION: state lives in per-isolate module memory. On Vercel's
 * Edge Runtime every isolate (region × instance) has its own Map, and a
 * cold start wipes it — so this is best-effort per-instance limiting, not
 * a global guarantee. A determined, distributed attacker needs a shared
 * edge store (Upstash/KV) or a WAF rule in front; what this DOES reliably
 * stop is the cheap single-source attacks above (one IP looping a fetch),
 * which is the realistic threat at this app's scale. Chosen over adding a
 * store dependency now, matching this codebase's no-new-infra habit.
 *
 * Keyed by caller IP: first value of x-forwarded-for (what Vercel sets to
 * the real client address), falling back to 'unknown' — meaning callers
 * with no XFF at all (only really possible outside a real deployment)
 * share one bucket, which fails toward limiting, not toward open.
 *
 * `now` is injectable (defaults to Date.now) purely so
 * tests/test-ratelimit.mjs can drive window expiry without sleeping.
 */
import { corsHeaders } from './cors.js';

const buckets = new Map(); // `${key}|${ip}` -> { windowStart, count }

// Memory bound: if the table ever grows past this (many distinct IPs in
// one window), sweep every bucket from older windows. Keeps worst-case
// memory flat without a timer, which edge isolates don't reliably keep.
const MAX_BUCKETS = 10_000;

/**
 * @param {Request} request
 * @param {{ key: string, limit: number, windowMs: number, now?: () => number }} opts
 * @returns {Response|null} a ready-to-send 429, or null (meaning: keep going)
 */
export function rateLimit(request, { key, limit, windowMs, now = Date.now }) {
  const ts = now();
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const ip = forwarded.split(',')[0].trim() || 'unknown';
  const id = `${key}|${ip}`;
  const windowStart = Math.floor(ts / windowMs) * windowMs;

  let bucket = buckets.get(id);
  if (!bucket || bucket.windowStart !== windowStart) {
    bucket = { windowStart, count: 0 };
    buckets.set(id, bucket);
  }
  bucket.count += 1;

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (b.windowStart !== windowStart) buckets.delete(k);
    }
  }

  if (bucket.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - ts) / 1000));
    return new Response(JSON.stringify({ error: 'Too many requests', code: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSec),
        ...corsHeaders(request),
      },
    });
  }
  return null;
}
