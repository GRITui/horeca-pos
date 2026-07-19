/* Sidekick — lib/teams.js
 *
 * Shared-single-identity team model (see sql/schema-core.sql's TEAM section
 * for the full "why"): a team member's data-owner cuid is resolved to
 * whoever's org they belong to, not their own — every existing resource
 * table/handler stays scoped by a single `user_cuid` exactly as it always
 * was, this is the one lookup that makes that still correct for a team
 * member.
 *
 * Invite tokens use the exact same base64url(JSON payload)+HMAC-SHA256
 * shape lib/auth.js's session tokens and lib/lineLogin.js's OAuth `state`
 * already established — reused here rather than reinvented. Signed with
 * SESSION_SECRET (not a new dedicated secret): unlike LINE_LOGIN_STATE_SECRET
 * being kept separate from SESSION_SECRET (different purpose AND different
 * trust boundary — a third party's OAuth flow), an invite token is an
 * internal action gated the same way a session already is; if
 * SESSION_SECRET is ever compromised, an attacker can already forge
 * sessions outright, which is strictly worse than forging an invite — so a
 * second required env var here would add setup burden without closing a
 * real gap.
 */
import { constantTimeEqual } from './lineLogin.js';

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

// A week is long enough to get around to accepting an invite shared over
// LINE/WhatsApp/wherever, short enough that a stale, forgotten invite link
// doesn't stay redeemable forever.
const INVITE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function signInviteToken({ orgOwnerCuid, role }, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ orgOwnerCuid, role, iat: Date.now() })));
  const sig = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
  return `${payload}.${sig}`;
}

// Returns { orgOwnerCuid, role } if validly signed and not expired, else
// null — never throws, matching verifySession()'s fail-closed shape.
export async function verifyInviteToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const expected = bytesToBase64Url(new Uint8Array(await hmacSha256(secret, payload)));
    if (!constantTimeEqual(expected, sig)) return null;
    const { orgOwnerCuid, role, iat } = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!orgOwnerCuid || (role !== 'admin' && role !== 'staff') || typeof iat !== 'number' || Date.now() - iat > INVITE_MAX_AGE_MS) return null;
    return { orgOwnerCuid, role };
  } catch {
    return null;
  }
}

// The effective account whose data a caller should read/write. A plain
// solo account (not a team member of anyone) resolves to itself — this is
// the overwhelmingly common case, so it's one indexed lookup, not a join.
export async function resolveDataOwner(sql, userCuid) {
  const rows = await sql(`select org_owner_cuid from team_members where member_cuid = $1`, [userCuid]);
  return rows.length ? rows[0].org_owner_cuid : userCuid;
}

// True only for an account that is itself the data owner — i.e. not
// resolved through someone else's team_members row. Billing actions
// (api/billing-checkout.js/api/billing-portal.js) are restricted to this:
// a team member (admin or staff) never manages the org's subscription,
// even if their role would otherwise let them invite/remove members.
export async function isAccountOwner(sql, userCuid) {
  const rows = await sql(`select 1 from team_members where member_cuid = $1`, [userCuid]);
  return rows.length === 0;
}

// { orgOwnerCuid, role } if this account is a member of someone else's
// team, else null. Whether an account is itself an owner is NOT this
// function's concern — that's just users.plan === 'team' (true the moment
// they're on the Team plan, whether or not they've invited anyone yet),
// checked directly wherever needed rather than inferred from team_members
// having rows.
export async function getMembership(sql, userCuid) {
  const rows = await sql(`select org_owner_cuid, role from team_members where member_cuid = $1`, [userCuid]);
  return rows.length ? rows[0] : null;
}
