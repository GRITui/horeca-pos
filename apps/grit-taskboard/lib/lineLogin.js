/* Sidekick — lib/lineLogin.js
 *
 * LINE Login (OAuth2 + OIDC) helpers — a DIFFERENT LINE channel from the
 * Messaging API one lib/line.js talks to (LINE Login and Messaging API are
 * separate channel types in the LINE Developers Console, each with its own
 * channel ID/secret). Used by api/line-login-start.js and
 * api/line-login-callback.js.
 *
 * Sidekick has no server-side session store (see app/app.js's header: "NO
 * backend, NO secrets" for the app itself — api/ is the one deliberate
 * exception, same as the existing LINE Messaging integration). So the OAuth
 * `state` param doubles as the CSRF/replay guard AND the only place the
 * per-attempt `nonce` (and the `returnTo` origin the user actually started
 * from — see api/line-login-start.js) can live between the start and
 * callback requests: it's a short-lived, HMAC-signed token (payload + '.' +
 * signature) verified with LINE_LOGIN_STATE_SECRET, not a value looked up
 * from server storage.
 *
 * The signature alone only proves the token wasn't tampered with — it does
 * NOT prove the browser completing the callback is the same one that
 * started the flow (a signed state value can be replayed by an attacker who
 * captures it via referrer/history/logs to force a victim into a login-CSRF
 * flow). api/line-login-start.js additionally sets a short-lived cookie
 * holding the same nonce, and api/line-login-callback.js checks the cookie
 * matches the nonce recovered from state — that's the actual browser-binding.
 */

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

// Timing-safe string comparison — the Edge runtime has no Node
// crypto.timingSafeEqual, and a plain `===` on a secret-derived signature is
// a (minor, but free-to-fix) side-channel leak of how many leading bytes
// matched.
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — matches a reasonable login-attempt window

// Signs {nonce, returnTo, ts} into a compact, tamper-evident token carried
// through the `state` query param round-trip (browser -> LINE -> our
// callback). `returnTo` is the already-allowlist-validated login.html URL the
// user actually started from (see api/line-login-start.js) — carrying it
// here, rather than trusting a callback-time query param, is what lets the
// callback send GitHub-Pages and Vercel-mirror users back to the origin (and
// therefore the local IndexedDB) they started from, not always the Vercel
// origin the callback itself runs on.
export async function signState({ nonce, returnTo }, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ nonce, returnTo, ts: Date.now() })));
  const sig = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
  return `${payload}.${sig}`;
}

// Returns the embedded {nonce, returnTo} if the signature is valid and the
// token isn't stale, else null (also null on any malformed input — never
// throws).
export async function verifyState(state, secret) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  try {
    const expected = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
    if (!constantTimeEqual(expected, sig)) return null;
    const { nonce, returnTo, ts } = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!nonce || typeof ts !== 'number' || Date.now() - ts > STATE_MAX_AGE_MS) return null;
    return { nonce, returnTo: typeof returnTo === 'string' ? returnTo : null };
  } catch {
    return null;
  }
}

// A LINE-authenticated account has no password (see sql/schema-core.sql's
// users.line_sub comment), so it can't reuse api/auth-register.js's
// salt/hash/iters-based flow to get a backend account for cloud
// backup/billing (Phase 0/2, 2026-07-16). This token is how that gap
// closes without a second OAuth round trip: api/line-login-callback.js
// mints one right after it has ALREADY done the real work (verifying the
// ID token against LINE) and hands it to the client alongside the local
// profile; the client stores it on the local account record so a later,
// separate "Enable cloud backup" click (api/auth-register-line.js) can
// prove — without re-authenticating with LINE — that this exact sub was
// genuinely verified once, not merely asserted by the client.
//
// Long-lived (a year, not this file's 10-minute STATE token window)
// because unlike `state`, this isn't bound to one login attempt — it's
// meant to sit unused in local IndexedDB for as long as the user hasn't
// opted into cloud backup yet, which is fully expected to be days or
// weeks. It doesn't grant any access by itself (only proves an identity
// to a registration endpoint), so a long window doesn't extend what a
// leaked copy could do beyond what a leaked session token already could —
// see api/auth-register-line.js's header for the full reasoning. Reuses
// LINE_LOGIN_STATE_SECRET rather than a new env var, same "an existing
// secret already covers this risk, a second one wouldn't close a new gap"
// call this codebase already made for team invite tokens (lib/teams.js).
const LINE_IDENTITY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export async function signLineIdentity({ sub, name, picture }, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ sub, name, picture, ts: Date.now() })));
  const sig = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
  return `${payload}.${sig}`;
}

export async function verifyLineIdentity(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const expected = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
    if (!constantTimeEqual(expected, sig)) return null;
    const { sub, name, picture, ts } = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!sub || typeof ts !== 'number' || Date.now() - ts > LINE_IDENTITY_MAX_AGE_MS) return null;
    return { sub, name: typeof name === 'string' ? name : '', picture: typeof picture === 'string' ? picture : '' };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl({ channelId, callbackUrl, state, nonce, scope = 'openid profile' }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: callbackUrl,
    state,
    scope,
    nonce,
  });
  return `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken({ code, channelId, channelSecret, callbackUrl }) {
  const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: channelId,
      client_secret: channelSecret,
    }),
  });
  if (!res.ok) throw new Error(`LINE token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json(); // { access_token, id_token, expires_in, refresh_token, scope, token_type }
}

// Verifies an HS256 ID token per LINE's own scheme (shared-secret HMAC, not
// RSA — see LINE's "Verify ID token" docs) and returns its decoded claims.
export async function verifyIdToken(idToken, { channelId, channelSecret, nonce }) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const [headerB64, payloadB64, sigB64] = parts;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, base64UrlToBytes(sigB64), new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('ID token signature verification failed');

  const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  if (claims.iss !== 'https://access.line.me') throw new Error('Unexpected ID token issuer');
  if (claims.aud !== channelId) throw new Error('Unexpected ID token audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('ID token expired');
  if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');

  return claims; // { sub, name, picture, email?, ... }
}
