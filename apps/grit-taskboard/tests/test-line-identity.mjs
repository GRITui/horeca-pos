import { signLineIdentity, verifyLineIdentity } from '../lib/lineLogin.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

function b64url(bytes) { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

async function main() {
  const secret = 'test-line-state-secret';

  // ── Valid roundtrip ─────────────────────────────────────────────────
  const token = await signLineIdentity({ sub: 'U1234567890', name: 'Alex', picture: 'https://x/p.jpg' }, secret);
  const verified = await verifyLineIdentity(token, secret);
  assert(verified && verified.sub === 'U1234567890' && verified.name === 'Alex' && verified.picture === 'https://x/p.jpg', 'a validly signed identity token verifies with the right payload');

  // Missing name/picture (LINE profile fields are optional) still verifies,
  // normalized to empty strings rather than undefined/null.
  const bareToken = await signLineIdentity({ sub: 'U999', name: '', picture: '' }, secret);
  const bareVerified = await verifyLineIdentity(bareToken, secret);
  assert(bareVerified && bareVerified.sub === 'U999' && bareVerified.name === '' && bareVerified.picture === '', 'a token with no name/picture still verifies, normalized to empty strings');

  // ── Tamper / wrong-secret rejection ─────────────────────────────────
  assert(await verifyLineIdentity(token, 'wrong-secret') === null, 'wrong secret rejects the token');
  const tampered = token.slice(0, -2) + 'xx';
  assert(await verifyLineIdentity(tampered, secret) === null, 'a tampered token is rejected');
  assert(await verifyLineIdentity('not-a-real-token', secret) === null, 'a malformed token is rejected, not thrown');
  assert(await verifyLineIdentity(null, secret) === null, 'a null token is rejected, not thrown');
  assert(await verifyLineIdentity(undefined, secret) === null, 'an undefined token is rejected, not thrown');

  // A validly-signed token missing `sub` entirely (hand-crafted, simulating
  // a corrupted/forged payload) is rejected — sub is the one required field.
  const noSubPayload = b64url(new TextEncoder().encode(JSON.stringify({ name: 'Nobody', ts: Date.now() })));
  const noSubSig = b64url(new Uint8Array(await hmac(secret, noSubPayload)));
  assert(await verifyLineIdentity(`${noSubPayload}.${noSubSig}`, secret) === null, 'a validly-signed token with no sub is rejected');

  // ── Expiry: hand-craft a token older than 365 days ──────────────────
  const oldPayload = b64url(new TextEncoder().encode(JSON.stringify({ sub: 'Uold', name: '', picture: '', ts: Date.now() - 366 * 24 * 60 * 60 * 1000 })));
  const oldSig = b64url(new Uint8Array(await hmac(secret, oldPayload)));
  assert(await verifyLineIdentity(`${oldPayload}.${oldSig}`, secret) === null, 'a token older than 365 days is rejected as expired');

  // A token just inside the window (364 days old) still verifies.
  const freshPayload = b64url(new TextEncoder().encode(JSON.stringify({ sub: 'Ufresh', name: '', picture: '', ts: Date.now() - 364 * 24 * 60 * 60 * 1000 })));
  const freshSig = b64url(new Uint8Array(await hmac(secret, freshPayload)));
  const freshVerified = await verifyLineIdentity(`${freshPayload}.${freshSig}`, secret);
  assert(freshVerified && freshVerified.sub === 'Ufresh', 'a 364-day-old token (inside the 365-day window) still verifies');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
