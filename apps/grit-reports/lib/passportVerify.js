/* grit-reports — lib/passportVerify.js
 *
 * Mirror of @grit/passport's session.ts verify path (packages/passport/src/
 * session.ts) for this app's no-build serverless functions, same rationale
 * as apps/grit-taskboard/lib/gritEvents.js mirroring @grit/shared-events:
 * this app can't import TypeScript source directly, and the task spec
 * forbids adding `jose` as a dependency here, so HS256 verification is done
 * by hand with Node's Web Crypto (`node:crypto`'s `webcrypto` export) —
 * the exact same primitive @grit/shared-events/src/webhook.ts uses for HMAC
 * signing, just applied to compact JWT verification instead.
 *
 * Wire contract (must stay identical to packages/passport/src/session.ts):
 *   - Cookie name: `grit_passport`
 *   - Alg: HS256 only (a token asserting any other `alg` is rejected)
 *   - Secret: env `GRIT_SESSION_SECRET`, falling back to `SESSION_SECRET`
 *   - Standard JWT `exp` (and `nbf`, if present) validation
 *   - Payload fields: userId, organizationId, locationId?, role, email,
 *     name?, tier, addons[] — see GritSession in session.ts
 *
 * If the session shape in session.ts changes, update this file to match.
 */

import { webcrypto } from "node:crypto";

export const GRIT_SESSION_COOKIE = "grit_passport";

const ROLES = ["owner", "manager", "staff"];
const TIERS = ["LITE", "GROWTH", "SCALE"];

// Mirror of packages/passport/src/entitlements.ts ADDON_MATRIX.custom_reporting
// (features: ["reports.custom_builder"], apps: ["reports"], minTier: "GROWTH").
// Duplicated here for the same reason session verification is duplicated:
// this app cannot import the TypeScript source. Keep in sync by hand.
const CUSTOM_REPORTING_MIN_TIER = "GROWTH";
const TIER_RANK = { LITE: 0, GROWTH: 1, SCALE: 2 };

function base64UrlToBuffer(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function decodeJsonSegment(segment) {
  return JSON.parse(base64UrlToBuffer(segment).toString("utf8"));
}

function getSessionSecret() {
  return process.env.GRIT_SESSION_SECRET ?? process.env.SESSION_SECRET ?? null;
}

async function importHmacKey(secret) {
  return webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verifies a compact HS256 JWT string and returns the session payload, or
 * `null` for anything invalid (missing token, no secret configured, bad
 * signature, wrong alg, malformed payload, expired/not-yet-valid, missing
 * required fields) — mirrors verifySessionToken()'s "never throw" contract
 * so callers can treat `null` uniformly as "not logged in".
 */
export async function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const secret = getSessionSecret();
  if (!secret) return null;

  const parts = token.split(".");
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
  if (!header || header.alg !== "HS256") return null;

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
    valid = await webcrypto.subtle.verify("HMAC", key, signature, signingInput);
  } catch {
    return null;
  }
  if (!valid) return null;
  if (!payload || typeof payload !== "object") return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && nowSeconds >= payload.exp) return null;
  if (typeof payload.nbf === "number" && nowSeconds < payload.nbf) return null;

  if (
    typeof payload.userId !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.role !== "string" ||
    !ROLES.includes(payload.role) ||
    typeof payload.tier !== "string" ||
    !TIERS.includes(payload.tier)
  ) {
    return null;
  }

  const addons = Array.isArray(payload.addons)
    ? payload.addons.filter((a) => typeof a === "string")
    : [];

  return {
    userId: payload.userId,
    organizationId: payload.organizationId,
    locationId: typeof payload.locationId === "string" ? payload.locationId : null,
    role: payload.role,
    email: payload.email,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    tier: payload.tier,
    addons,
  };
}

/** Extracts the passport token from a raw `Cookie` request header. */
export function readSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === GRIT_SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Resolves the session from a standard Fetch API `Request`: prefers
 * `Authorization: Bearer <jwt>`, falls back to the `grit_passport` cookie.
 */
export async function sessionFromRequest(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const session = await verifySessionToken(token);
    if (session) return session;
  }
  const cookieHeader = request.headers.get("cookie");
  const token = readSessionCookie(cookieHeader);
  return verifySessionToken(token);
}

/**
 * Mirror of hasFeatureAccess(session, "reports.custom_builder") from
 * packages/passport/src/entitlements.ts, specialized to the one feature
 * this app's aggregator gates on.
 */
export function hasCustomReportingAddon(session) {
  if (!session) return false;
  if (!Array.isArray(session.addons) || !session.addons.includes("custom_reporting")) {
    return false;
  }
  const tierRank = TIER_RANK[session.tier];
  if (tierRank === undefined) return false;
  return tierRank >= TIER_RANK[CUSTOM_REPORTING_MIN_TIER];
}
