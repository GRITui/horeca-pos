import { resolveDataOwner, isAccountOwner, getMembership, signInviteToken, verifyInviteToken } from '../lib/teams.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// Fake sql: a tiny in-memory team_members table.
const TEAM_MEMBERS = [
  { org_owner_cuid: 'owner-1', member_cuid: 'staff-1', role: 'staff' },
  { org_owner_cuid: 'owner-1', member_cuid: 'admin-1', role: 'admin' },
];
function fakeSql(strings, ...values) {
  // Support both tagged-template and (text, params) call styles, matching
  // the real Neon driver's dual API this codebase already relies on.
  const text = Array.isArray(strings) ? strings.join('?') : strings;
  const params = Array.isArray(strings) ? values : values[0];
  if (text.includes('select org_owner_cuid from team_members where member_cuid')) {
    const cuid = params[0];
    const row = TEAM_MEMBERS.find(m => m.member_cuid === cuid);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid }] : []);
  }
  if (text.includes('select 1 from team_members where member_cuid')) {
    const cuid = params[0];
    return Promise.resolve(TEAM_MEMBERS.some(m => m.member_cuid === cuid) ? [{ '?column?': 1 }] : []);
  }
  if (text.includes('select org_owner_cuid, role from team_members where member_cuid')) {
    const cuid = params[0];
    const row = TEAM_MEMBERS.find(m => m.member_cuid === cuid);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid, role: row.role }] : []);
  }
  throw new Error('unexpected query in fakeSql: ' + text);
}
// Tagged-template wrapper so `sql\`...\`` call sites work too (lib/teams.js
// uses tagged templates internally).
function taggedSql(strings, ...values) { return fakeSql(strings, ...values); }

async function main() {
  // ── resolveDataOwner ──────────────────────────────────────────────
  assert(await resolveDataOwner(taggedSql, 'staff-1') === 'owner-1', 'staff member resolves to org owner');
  assert(await resolveDataOwner(taggedSql, 'admin-1') === 'owner-1', 'admin member resolves to org owner');
  assert(await resolveDataOwner(taggedSql, 'owner-1') === 'owner-1', 'a plain solo account (not a member of anyone) resolves to itself');
  assert(await resolveDataOwner(taggedSql, 'nobody') === 'nobody', 'an unknown/never-a-member cuid resolves to itself');

  // ── isAccountOwner ────────────────────────────────────────────────
  assert(await isAccountOwner(taggedSql, 'owner-1') === true, 'org owner is an account owner');
  assert(await isAccountOwner(taggedSql, 'staff-1') === false, 'staff member is NOT an account owner (billing restriction target)');
  assert(await isAccountOwner(taggedSql, 'admin-1') === false, 'admin member is NOT an account owner either — billing stays owner-only');

  // ── getMembership ─────────────────────────────────────────────────
  const staffMembership = await getMembership(taggedSql, 'staff-1');
  assert(staffMembership && staffMembership.org_owner_cuid === 'owner-1' && staffMembership.role === 'staff', 'getMembership returns the right org+role for staff');
  assert(await getMembership(taggedSql, 'owner-1') === null, 'the owner itself has no membership row (implicit, not stored)');

  // ── invite token sign/verify ──────────────────────────────────────
  const secret = 'test-secret-value';
  const token = await signInviteToken({ orgOwnerCuid: 'owner-1', role: 'staff' }, secret);
  const verified = await verifyInviteToken(token, secret);
  assert(verified && verified.orgOwnerCuid === 'owner-1' && verified.role === 'staff', 'a validly signed invite token verifies with the right payload');

  assert(await verifyInviteToken(token, 'wrong-secret') === null, 'wrong secret rejects the token');
  const tamperedToken = token.slice(0, -2) + 'xx';
  assert(await verifyInviteToken(tamperedToken, secret) === null, 'a tampered token is rejected');
  assert(await verifyInviteToken('not-a-real-token', secret) === null, 'a malformed token is rejected, not thrown');
  assert(await verifyInviteToken(null, secret) === null, 'a null token is rejected, not thrown');

  // Role must be admin or staff — a forged/corrupted 'owner' role payload
  // (even if somehow validly signed against a leaked secret) is rejected,
  // since 'owner' is never a legitimate invite role.
  const forgedOwnerPayload = await signInviteToken({ orgOwnerCuid: 'owner-1', role: 'owner' }, secret).catch(() => null);
  // signInviteToken doesn't validate role itself (verifyInviteToken does) —
  // simulate a forged payload bypassing signInviteToken's normal role arg.
  function b64url(bytes) { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function hmac(secret, message) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  }
  const badPayload = b64url(new TextEncoder().encode(JSON.stringify({ orgOwnerCuid: 'owner-1', role: 'owner', iat: Date.now() })));
  const badSig = b64url(new Uint8Array(await hmac(secret, badPayload)));
  assert(await verifyInviteToken(`${badPayload}.${badSig}`, secret) === null, "a validly-signed but role='owner' token is still rejected — owner is never a real invite role");

  // Expiry: hand-craft a token with an old iat.
  const oldPayload = b64url(new TextEncoder().encode(JSON.stringify({ orgOwnerCuid: 'owner-1', role: 'staff', iat: Date.now() - 8 * 24 * 60 * 60 * 1000 })));
  const oldSig = b64url(new Uint8Array(await hmac(secret, oldPayload)));
  assert(await verifyInviteToken(`${oldPayload}.${oldSig}`, secret) === null, 'an invite older than 7 days is rejected as expired');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
