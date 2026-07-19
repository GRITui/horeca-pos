/* Grit Taskboard — lib/passport.js
 *
 * Plain-JS mirror of @grit/passport's session verification
 * (packages/passport/src/session.ts), for this app's no-build serverless
 * functions — same rationale as lib/gritEvents.js mirroring
 * packages/shared-events (see that file's header and this monorepo's
 * AGENTS.md): this app has no build step and can't import TypeScript
 * source, so the JWT is hand-verified with node:crypto's Web Crypto surface
 * (`webcrypto`), the same primitive lib/gritEvents.js and
 * apps/grit-reports/lib/passportVerify.js both use for their own
 * HMAC-family verification instead of pulling in `jose`.
 *
 * Wire contract (must stay identical to packages/passport/src/session.ts —
 * if that file's session shape changes, update this file to match):
 *   - Cookie name: `grit_passport`
 *   - Alg: HS256 only (a token asserting any other `alg` is rejected)
 *   - Standard JWT `exp` (and `nbf`, if present) validation
 *   - Payload fields: userId, organizationId, locationId?, role, email,
 *     name?, tier, addons[] — see GritSession in session.ts
 *
 * *** Deliberate divergence from packages/passport/README.md's mirror
 * snippet and apps/grit-reports/lib/passportVerify.js: secret resolution
 * here is GRIT_SESSION_SECRET ONLY — the `?? process.env.SESSION_SECRET`
 * fallback every other mirror in the suite documents/implements is
 * intentionally NOT wired in this file. This app's own SESSION_SECRET
 * (lib/auth.js) already signs a completely unrelated bearer-token scheme —
 * this app's native 30-day user sessions (see lib/auth.js's header) — so
 * falling back to it here would mean a Grit Passport token and this app's
 * own session token are HMAC'd with the same key for two different wire
 * formats, both reachable over HTTP. That's a real key-reuse/collision risk
 * for no benefit: this app can simply require GRIT_SESSION_SECRET to be set
 * explicitly for Passport SSO, same as every other required-env-var gate
 * here (see .env.example). If GRIT_SESSION_SECRET is unset, Grit Passport
 * verification is disabled outright (verifyPassportSession always returns
 * null) rather than silently reusing SESSION_SECRET. See .env.example and
 * README.md's "Grit Passport SSO" section for the same note. ***
 *
 * Not wired into any endpoint's auth today — api/grit-events.js is
 * HMAC-authenticated (a different app calling in, see that file's header)
 * and has no use for a user session; api/ops-tasks.js keeps its own
 * lib/auth.js bearer scheme plus the GRIT_SERVICE_TOKEN service path (see
 * that file). This module exists ahead of use for a future "Continue with
 * Grit Passport" UI login path (mirroring api/line-login-callback.js's
 * shape) — exported now so that work doesn't have to re-derive the wire
 * format from scratch.
 */
import { webcrypto } from 'node:crypto';

export const GRIT_PASSPORT_COOKIE = 'grit_passport';

const ROLES = ['owner', 'manager', 'staff'];
const TIERS = ['LITE', 'GROWTH', 'SCALE'];
const TIER_RANK = { LITE: 0, GROWTH: 1, SCALE: 2 };

// Mirror of packages/passport/src/entitlements.ts TIER_MATRIX's
// `taskboard.automation` row (Commercial Core Configurations Matrix in
// packages/passport/README.md): SCALE only, no addon unlocks it early,
// unlike `reports.custom_builder`. Duplicated here for the same reason
// session verification is duplicated: this app cannot import the
// TypeScript source. Keep in sync by hand with entitlements.ts.
const TASKBOARD_AUTOMATION_MIN_TIER = 'SCALE';

function base64UrlToBuffer(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

function decodeJsonSegment(segment) {
  return JSON.parse(base64UrlToBuffer(segment).toString('utf8'));
}

// GRIT_SESSION_SECRET only — see file header for why this mirror does NOT
// fall back to SESSION_SECRET the way every other mirror in the suite does.
function getPassportSecret() {
  return process.env.GRIT_SESSION_SECRET || null;
}

async function importHmacKey(secret) {
  return webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

/**
 * Verifies a compact HS256 JWT string and returns the GritSession payload,
 * or `null` for anything invalid (no GRIT_SESSION_SECRET configured, bad
 * signature, wrong alg, malformed payload, expired/not-yet-valid, missing
 * required fields) — mirrors verifySessionToken()'s "never throw" contract
 * (packages/passport/src/session.ts) so callers can treat `null` uniformly
 * as "not logged in".
 */
export async function verifyPassportToken(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = getPassportSecret();
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header;
  let payload;
  try {
    header = decodeJsonSegment(headerSeg);
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;

  let signature;
  try {
    signature = base64UrlToBuffer(sigSeg);
  } catch {
    return null;
  }

  let key;
  try {
    key = await importHmacKey(secret);
  } catch {
    return null;
  }

  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  let valid = false;
  try {
    valid = await webcrypto.subtle.verify('HMAC', key, signature, signingInput);
  } catch {
    return null;
  }
  if (!valid) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSeconds >= payload.exp) return null;
  if (typeof payload.nbf === 'number' && nowSeconds < payload.nbf) return null;

  if (
    typeof payload.userId !== 'string' ||
    typeof payload.organizationId !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.role !== 'string' ||
    !ROLES.includes(payload.role) ||
    typeof payload.tier !== 'string' ||
    !TIERS.includes(payload.tier)
  ) {
    return null;
  }

  const addons = Array.isArray(payload.addons)
    ? payload.addons.filter((a) => typeof a === 'string')
    : [];

  return {
    userId: payload.userId,
    organizationId: payload.organizationId,
    locationId: typeof payload.locationId === 'string' ? payload.locationId : null,
    role: payload.role,
    email: payload.email,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    tier: payload.tier,
    addons,
  };
}

/** Extracts the grit_passport token from a raw `Cookie` request header. */
export function readPassportCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === GRIT_PASSPORT_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Resolves the Grit Passport session from a standard Fetch API `Request`
 * (this app's api/*.js handlers all receive one): prefers
 * `Authorization: Bearer <jwt>`, falls back to the `grit_passport` cookie —
 * same precedence as apps/grit-reports/lib/passportVerify.js's
 * sessionFromRequest. Returns the session payload, or `null` if neither is
 * present/valid.
 */
export async function verifyPassportSession(req) {
  const authHeader = req.headers.get('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const session = await verifyPassportToken(token);
    if (session) return session;
  }
  const cookieHeader = req.headers.get('cookie');
  const token = readPassportCookie(cookieHeader);
  return verifyPassportToken(token);
}

/**
 * Minimal tier gate for taskboard's own gated feature set — mirrors
 * hasFeatureAccess(session, "taskboard.automation") from
 * packages/passport/src/entitlements.ts, specialized to the one feature
 * this app would ever gate on (taskboard only mounts at all on SCALE, per
 * that package's Commercial Core Configurations Matrix — no addon unlocks
 * it early). `feature` is accepted as a parameter (not hardcoded) so this
 * reads like the shared hasFeatureAccess() call site it mirrors, but only
 * `"taskboard.automation"` is currently recognized — any other key is
 * unentitled by default rather than silently true, so a typo'd feature
 * string fails closed instead of granting access.
 */
export function hasFeature(session, feature) {
  if (!session) return false;
  if (feature !== 'taskboard.automation') return false;
  const tierRank = TIER_RANK[session.tier];
  if (tierRank === undefined) return false;
  return tierRank >= TIER_RANK[TASKBOARD_AUTOMATION_MIN_TIER];
}
