import "server-only";

import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Lazily-initialized Stripe client. Must NOT throw at import time when
// STRIPE_SECRET_KEY is unset (e.g. during `next build`, or on deploys that
// haven't configured Stripe yet) — the client is only constructed the first
// time it's actually needed.
// ---------------------------------------------------------------------------

let stripeClient: Stripe | null = null;

/** Returns a cached Stripe client, constructing it on first use. */
export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill in your Stripe secret key.",
    );
  }

  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

// ---------------------------------------------------------------------------
// Stripe webhook signature verification, implemented with the Web Crypto
// `SubtleCrypto` API instead of Node's `crypto` module so it also works
// unmodified on Vercel Edge / other non-Node runtimes.
//
// Mirrors Stripe's documented scheme: the `Stripe-Signature` header is a
// comma-separated list of `key=value` pairs, `t` is a unix timestamp and
// `v1` is hex(HMAC-SHA256(secret, `${t}.${payload}`)).
// https://docs.stripe.com/webhooks#verify-manually
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE_SECONDS = 5 * 60; // 5 minutes, same default as Stripe's own SDK

function parseSignatureHeader(
  header: string,
): { timestamp: string; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const pair of header.split(",")) {
    const [key, value] = pair.split("=");
    if (key && value) parts[key.trim()] = value.trim();
  }
  if (!parts.t || !parts.v1) return null;
  return { timestamp: parts.t, v1: parts.v1 };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison (equal-length hex digests). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies a Stripe webhook request. `payload` must be the *raw* request
 * body text (not re-serialized JSON) and `signature` the raw
 * `Stripe-Signature` header value. Returns `true` if the signature is valid
 * and the timestamp is within tolerance, `false` otherwise — never throws,
 * so callers can respond with a plain 400 on failure.
 */
export async function verifyStripeWebhook(
  payload: string,
  signature: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<boolean> {
  const parsed = parseSignatureHeader(signature);
  if (!parsed) return false;

  const { timestamp, v1 } = parsed;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const eventSeconds = Number(timestamp);
  if (!Number.isFinite(eventSeconds)) return false;
  if (Math.abs(nowSeconds - eventSeconds) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedPayload = `${timestamp}.${payload}`;
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );

  return timingSafeEqualHex(toHex(digest), v1);
}
