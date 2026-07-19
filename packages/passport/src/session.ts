/**
 * Grit Passport session contract — one login for every Grit BizSuite app.
 *
 * The session is a signed HS256 JWT (jose) carried in a shared cookie
 * (`grit_passport`). This module unifies the two legacy session shapes
 * (grit-pos `horeca_session`: userId/tenantId/role/email, and grit-inventory
 * `invento_session`: sub/tenantId/storeId/role/email/name) into one payload
 * that every app can mint and verify.
 *
 * Framework-agnostic on purpose: functions take and return strings — no
 * `next/headers`, no framework cookie APIs. Next.js apps wire the token into
 * `cookies()` themselves; plain serverless functions (grit-taskboard) read the
 * cookie header and call `verifySessionToken` directly.
 */

import { SignJWT, jwtVerify } from "jose";

// -- Types -------------------------------------------------------------------

/** Unified role vocabulary. Legacy mapping: OWNER→owner, ADMIN→manager, STAFF→staff. */
export type GritRole = "owner" | "manager" | "staff";

/** Commercial tier of the organization (see src/entitlements.ts). */
export type GritTier = "LITE" | "GROWTH" | "SCALE";

/**
 * The one session payload shared by all Grit BizSuite apps.
 *
 * - `organizationId` replaces the legacy `tenantId`.
 * - `locationId` replaces the legacy `storeId` (null/absent = org-wide session).
 * - `tier` + `addons` are stamped at login so entitlement checks never need a
 *   DB round-trip; re-issue the token when the org's plan changes.
 */
export interface GritSession {
  userId: string;
  organizationId: string;
  locationId?: string | null;
  role: GritRole;
  email: string;
  name?: string;
  tier: GritTier;
  addons: string[];
}

// -- Constants ---------------------------------------------------------------

/** Shared cookie name. All apps read/write this single cookie. */
export const GRIT_SESSION_COOKIE = "grit_passport";

/** Session lifetime: 7 days (matches both legacy apps). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const ROLES: readonly string[] = ["owner", "manager", "staff"];
const TIERS: readonly string[] = ["LITE", "GROWTH", "SCALE"];

// -- Secret handling ---------------------------------------------------------

const encoder = new TextEncoder();

function getSessionSecret(explicit?: string): Uint8Array {
  const secret =
    explicit ?? process.env.GRIT_SESSION_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "GRIT_SESSION_SECRET is not set (fallback SESSION_SECRET also empty). " +
        "Every Grit app must share the same secret for SSO to work — " +
        "generate one with `openssl rand -base64 32` and set it in each app's env.",
    );
  }
  return encoder.encode(secret);
}

// -- Token issuing / verification --------------------------------------------

export interface SessionTokenOptions {
  /** Override the env-derived secret (mainly for tests). */
  secret?: string;
  /** Override the 7-day TTL, in seconds. */
  ttlSeconds?: number;
}

/**
 * Signs a `GritSession` into a compact JWT string. The caller decides how to
 * deliver it (Next `cookies().set`, a raw `Set-Cookie` header, …).
 */
export async function createSessionToken(
  session: GritSession,
  options: SessionTokenOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  return new SignJWT({
    userId: session.userId,
    organizationId: session.organizationId,
    locationId: session.locationId ?? null,
    role: session.role,
    email: session.email,
    ...(session.name !== undefined ? { name: session.name } : {}),
    tier: session.tier,
    addons: session.addons,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(getSessionSecret(options.secret));
}

/**
 * Verifies a session token and returns the typed session, or `null` for any
 * missing/expired/tampered/malformed token — never throws on bad input, so
 * callers can treat `null` uniformly as "not logged in".
 */
export async function verifySessionToken(
  token: string | null | undefined,
  options: Pick<SessionTokenOptions, "secret"> = {},
): Promise<GritSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(options.secret), {
      algorithms: ["HS256"],
    });
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
      ? payload.addons.filter((a): a is string => typeof a === "string")
      : [];
    return {
      userId: payload.userId,
      organizationId: payload.organizationId,
      locationId:
        typeof payload.locationId === "string" ? payload.locationId : null,
      role: payload.role as GritRole,
      email: payload.email,
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      tier: payload.tier as GritTier,
      addons,
    };
  } catch {
    // Expired, bad signature, malformed — all "not logged in".
    return null;
  }
}

// -- Cookie header helpers (for non-framework runtimes) ----------------------

export interface SessionCookieOptions {
  /** Defaults to `SESSION_TTL_SECONDS`. */
  maxAgeSeconds?: number;
  /** Add the `Secure` attribute (default: true — disable only for local HTTP dev). */
  secure?: boolean;
  /**
   * Cookie `Domain` (e.g. `.grit.example.com`) so the cookie is shared across
   * app subdomains. Omit for host-only cookies (single-domain / localhost dev).
   */
  domain?: string;
}

/**
 * Builds a `Set-Cookie` header value for the session token. Useful in plain
 * serverless functions; Next apps typically use `cookies().set` with the same
 * attributes instead.
 */
export function sessionCookieHeader(
  token: string,
  options: SessionCookieOptions = {},
): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_TTL_SECONDS;
  const parts = [
    `${GRIT_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/** `Set-Cookie` header value that clears the session cookie (logout). */
export function clearSessionCookieHeader(
  options: Pick<SessionCookieOptions, "domain" | "secure"> = {},
): string {
  const parts = [
    `${GRIT_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Extracts the passport token from a raw `Cookie` request header. For plain
 * serverless functions that don't have a cookie parser.
 */
export function readSessionCookie(
  cookieHeader: string | null | undefined,
): string | null {
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
