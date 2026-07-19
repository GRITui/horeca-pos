/* Sidekick — lib/auth.js
 *
 * Bearer-token session auth for the Phase 1 backend migration (see the
 * project plan for the full "why"). Deliberately NOT cookies and NOT JWT:
 *
 * - Not cookies: GitHub Pages (canonical prod) and Vercel (API host) are
 *   cross-origin, so a cookie session needs SameSite=None + CORS-with-
 *   credentials. A bearer token sidesteps that, and the client already
 *   treats localStorage as its source of session truth (SESSION_KEY in
 *   app.js), so storing this token alongside it fits the existing pattern.
 * - Not JWT: no need for a library or a standard claims shape here, this
 *   token only ever has to round-trip between this app's own client and
 *   its own API. Reuses the exact "base64url(JSON payload) + '.' +
 *   HMAC-SHA256 signature" technique lib/lineLogin.js already proved out
 *   for the OAuth `state` param (signState/verifyState) — same shape,
 *   longer max-age, different payload ({userCuid} instead of
 *   {nonce, returnTo}).
 *
 * Also holds the server-side half of password hashing: the exact same
 * PBKDF2-SHA256 scheme app.js's client-side hashPassword() uses (same
 * salt/iters/hash triple), so hashes computed in the browser today (and
 * uploaded verbatim during the one-time local->server migration) verify
 * correctly here without ever having transmitted a plaintext password
 * during that migration step.
 */
import { constantTimeEqual } from './lineLogin.js';

export { constantTimeEqual };

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64url.length % 4) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

// A session is a signed {userCuid, iat} token, valid for 30 days — a
// deliberately long-lived "remember me"-style session, matching this app's
// existing local-session behavior (no expiry at all today; 30 days is the
// first real expiry this app has ever had, chosen as a reasonable balance
// rather than copying the OAuth `state` param's much shorter 10-minute
// window, which exists for a different reason — bounding a login attempt,
// not a session).
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function signSession({ userCuid }, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ userCuid, iat: Date.now() })));
  const sig = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
  return `${payload}.${sig}`;
}

// Returns { userCuid } if the token is validly signed and not expired, else
// null (never throws — malformed/tampered/expired input all just fail
// closed).
export async function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const expected = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
    if (!constantTimeEqual(expected, sig)) return null;
    const { userCuid, iat } = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!userCuid || typeof iat !== 'number' || Date.now() - iat > SESSION_MAX_AGE_MS) return null;
    return { userCuid };
  } catch {
    return null;
  }
}

// Pulls "Authorization: Bearer <token>" off a Request and resolves it to
// {userCuid}, or null if missing/invalid/expired. Every crudHandler.js
// endpoint uses this — and only this — to know who's asking; never a
// client-supplied uid/user_cuid field in the request body or query string.
export async function requireSession(request, secret) {
  const header = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  return verifySession(m[1], secret);
}

// ─── Password hashing — server-side mirror of app.js's hashPassword() ─────
// Same algorithm (PBKDF2-SHA256), same output shape (lowercase hex string),
// so a {salt, hash, iters} triple computed client-side (at registration, or
// carried over as-is during the local->server migration) verifies here
// without needing the client's original plaintext password ever again.
export async function hashPassword(password, salt, iters) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iters },
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomSalt() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

// Verifies a login attempt's plaintext password against a stored
// {salt, hash, iters} row. Deliberately takes the plaintext password here
// (sent over HTTPS to api/auth-login.js) rather than requiring the client
// to fetch its own salt first and hash locally — that two-step "challenge"
// dance is what the local-only app effectively did for free (a local DB
// lookup has no network round trip to avoid), but once a real network
// round trip exists at all, sending the password once over TLS and hashing
// it here is simpler and avoids a username-enumeration timing side-channel
// a separate "give me my salt" endpoint would otherwise need its own
// defenses against.
export async function verifyPassword(password, { salt, hash, iters }) {
  if (!salt || !hash || !iters) return false;
  const computed = await hashPassword(password, salt, iters);
  return constantTimeEqual(computed, hash);
}
