/**
 * HMAC-signed internal webhooks — the transport for cross-app events.
 *
 * Uses Web Crypto only (no Node-specific imports) so it runs in Next.js
 * route handlers, edge runtimes, and plain Vercel serverless functions alike.
 * The no-build JS apps (grit-taskboard) keep a mirrored implementation in
 * their own lib; the wire format here is the contract:
 *
 *   POST <subscriber endpoint>
 *   content-type: application/json
 *   x-grit-event: <event name>
 *   x-grit-timestamp: <unix seconds>
 *   x-grit-signature: v1=<hex hmac-sha256 of "<timestamp>.<raw body>">
 */

const SIGNATURE_VERSION = "v1";
const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SignedWebhookHeaders {
  [header: string]: string;
  "content-type": "application/json";
  "x-grit-event": string;
  "x-grit-timestamp": string;
  "x-grit-signature": string;
}

export async function signWebhook(
  secret: string,
  eventName: string,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SignedWebhookHeaders> {
  const digest = await hmacSha256Hex(secret, `${nowSeconds}.${rawBody}`);
  return {
    "content-type": "application/json",
    "x-grit-event": eventName,
    "x-grit-timestamp": String(nowSeconds),
    "x-grit-signature": `${SIGNATURE_VERSION}=${digest}`,
  };
}

export interface VerifyWebhookInput {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/** Returns true only for a fresh, correctly signed payload. */
export async function verifyWebhook({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
}: VerifyWebhookInput): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const [version, digest] = signatureHeader.split("=", 2);
  if (version !== SIGNATURE_VERSION || !digest) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqualHex(digest, expected);
}
