/* Grit Taskboard — lib/gritEvents.js
 *
 * Plain-JS mirror of packages/shared-events (src/webhook.ts + src/contracts.ts).
 * This app has no build step and can't import TypeScript source directly
 * (see AGENTS.md), so the wire format is hand-mirrored here instead —
 * change the wire format in BOTH places, same rule that already governs
 * this file's existence per the monorepo's AGENTS.md.
 *
 * Wire format (identical to packages/shared-events/src/webhook.ts):
 *
 *   POST <subscriber endpoint>
 *   content-type: application/json
 *   x-grit-event: <event name>
 *   x-grit-timestamp: <unix seconds>
 *   x-grit-signature: v1=<hex hmac-sha256 of "<timestamp>.<raw body>">
 *
 * Secret: GRIT_EVENT_WEBHOOK_SECRET (shared across every Grit BizSuite app).
 * Tolerance: 5 minutes, same DEFAULT_TOLERANCE_SECONDS as the TS original.
 *
 * Uses node:crypto (not Web Crypto/crypto.subtle like the TS original) —
 * deliberately, since this module only ever runs from api/*.js handlers on
 * the Node.js Vercel runtime (config.runtime: 'nodejs'), never from the
 * browser or an edge function; node:crypto's timingSafeEqual is the more
 * direct tool there and needs no `await` to import a key first.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_VERSION = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;

// Same catalogue as packages/shared-events/src/contracts.ts EVENT_NAMES.
export const EVENT_NAMES = [
  'transaction.completed',
  'inventory.threshold_breached',
  'inventory.transfer_completed',
  'pos.velocity_surge',
  'task.completed',
];

function hmacSha256Hex(secret, message) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

// Timing-safe hex-string compare. node:crypto's timingSafeEqual throws on
// mismatched-length buffers rather than returning false, so the length
// check happens first — both a cheap short-circuit for the common "totally
// wrong signature" case and what keeps the exception path from being usable
// as a length oracle.
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Mirrors signWebhook() in packages/shared-events/src/webhook.ts. Used by
// api/ops-tasks.js to sign the outbound task.completed delivery.
export function signGritWebhook(secret, eventName, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  const digest = hmacSha256Hex(secret, `${nowSeconds}.${rawBody}`);
  return {
    'content-type': 'application/json',
    'x-grit-event': eventName,
    'x-grit-timestamp': String(nowSeconds),
    'x-grit-signature': `${SIGNATURE_VERSION}=${digest}`,
  };
}

// Mirrors verifyWebhook() in packages/shared-events/src/webhook.ts. Returns
// true only for a fresh, correctly signed payload — never throws (a
// malformed header/timestamp is just a `false`, same fail-closed shape
// lib/auth.js's verifySession() already established for this app).
export function verifyGritWebhook({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (!secret || !signatureHeader || !timestampHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const eqIdx = signatureHeader.indexOf('=');
  if (eqIdx < 0) return false;
  const version = signatureHeader.slice(0, eqIdx);
  const digest = signatureHeader.slice(eqIdx + 1);
  if (version !== SIGNATURE_VERSION || !digest) return false;
  const expected = hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  try {
    return timingSafeEqualHex(digest, expected);
  } catch {
    return false;
  }
}

// ─── Minimal envelope + data validation (mirrors contracts.ts) ────────────
function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

// Only the two events this app actually consumes get a data-shape
// validator — everything else in EVENT_NAMES (transaction.completed,
// inventory.transfer_completed, task.completed itself) validates on
// envelope shape alone below, since this app never reads their `data` and
// api/grit-events.js 202-ignores them before any data field is touched.
const DATA_VALIDATORS = {
  'inventory.threshold_breached': d =>
    isRecord(d) &&
    isNonEmptyString(d.location_id) &&
    isNonEmptyString(d.sku) &&
    isNonEmptyString(d.product_id) &&
    isNonEmptyString(d.product_name) &&
    isFiniteNumber(d.quantity_available) &&
    isFiniteNumber(d.reorder_threshold),
  'pos.velocity_surge': d =>
    isRecord(d) &&
    isNonEmptyString(d.location_id) &&
    isFiniteNumber(d.transactions_in_window) &&
    isFiniteNumber(d.window_minutes) &&
    isFiniteNumber(d.threshold),
};

export function isGritEventName(v) {
  return typeof v === 'string' && EVENT_NAMES.includes(v);
}

// Validates the common envelope ({event, timestamp, event_id,
// organization_id, data}) and, when a validator is registered for `event`,
// the data shape too. Returns the value as-is (typed only by convention,
// this is plain JS) on success, or null.
export function parseGritEvent(value) {
  if (!isRecord(value)) return null;
  const { event, timestamp, event_id, organization_id, data } = value;
  if (!isGritEventName(event)) return null;
  if (!isNonEmptyString(timestamp) || Number.isNaN(Date.parse(timestamp))) return null;
  if (!isNonEmptyString(event_id) || !isNonEmptyString(organization_id)) return null;
  const validator = DATA_VALIDATORS[event];
  if (validator && !validator(data)) return null;
  return value;
}
