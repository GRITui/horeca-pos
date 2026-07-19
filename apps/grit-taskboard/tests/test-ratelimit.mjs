// Sidekick — lib/rateLimit.js fixed-window limiter. Time is injected via
// the `now` option so window expiry is tested without sleeping.
import { rateLimit } from '../lib/rateLimit.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const req = (ip) => new Request('https://x/api/thing', { headers: ip ? { 'x-forwarded-for': ip } : {} });

let t = 1_000_000;
const now = () => t;

// ── Under the limit: allowed ─────────────────────────────────────────────
for (let i = 0; i < 5; i++) {
  assert(rateLimit(req('1.1.1.1'), { key: 'k1', limit: 5, windowMs: 60_000, now }) === null, `request ${i + 1}/5 allowed`);
}

// ── Over the limit: 429 with retry-after ────────────────────────────────
const blocked = rateLimit(req('1.1.1.1'), { key: 'k1', limit: 5, windowMs: 60_000, now });
assert(blocked && blocked.status === 429, '6th request in the window → 429');
assert(blocked && Number(blocked.headers.get('retry-after')) >= 1, '429 carries a retry-after header');

// ── Distinct IPs and distinct keys have their own buckets ────────────────
assert(rateLimit(req('2.2.2.2'), { key: 'k1', limit: 5, windowMs: 60_000, now }) === null, 'another IP is not affected');
assert(rateLimit(req('1.1.1.1'), { key: 'k2', limit: 5, windowMs: 60_000, now }) === null, 'another endpoint key is not affected');

// ── Window reset ─────────────────────────────────────────────────────────
t += 60_000;
assert(rateLimit(req('1.1.1.1'), { key: 'k1', limit: 5, windowMs: 60_000, now }) === null, 'next window admits the same IP again');

// ── Missing XFF shares the conservative "unknown" bucket ─────────────────
for (let i = 0; i < 3; i++) rateLimit(req(null), { key: 'k3', limit: 3, windowMs: 60_000, now });
const unknownBlocked = rateLimit(req(null), { key: 'k3', limit: 3, windowMs: 60_000, now });
assert(unknownBlocked && unknownBlocked.status === 429, 'no-XFF callers share one bucket that fails toward limiting');

// ── XFF parsing takes the first (client) hop ─────────────────────────────
for (let i = 0; i < 3; i++) rateLimit(req('9.9.9.9, 10.0.0.1'), { key: 'k4', limit: 3, windowMs: 60_000, now });
const chained = rateLimit(req('9.9.9.9, 172.16.0.9'), { key: 'k4', limit: 3, windowMs: 60_000, now });
assert(chained && chained.status === 429, 'first XFF value identifies the caller regardless of later proxy hops');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
