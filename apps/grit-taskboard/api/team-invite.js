/* Sidekick — api/team-invite.js
 *
 * Mints a signed, stateless invite link — no row written until the
 * invitee actually redeems it (api/team-join.js). Callable by the org
 * owner themselves, or an existing 'admin' member on their behalf; never
 * by 'staff' (see lib/teams.js's header for the role model). Requires the
 * org's plan to actually be 'team' — inviting is what Basic/Pro accounts
 * don't get, gated the same way every other plan feature is.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { getMembership, signInviteToken } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const APP_ORIGIN = process.env.APP_ORIGIN || 'https://gritui.github.io/Sidekickz';

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const body = await request.json().catch(() => null);
  const role = body && body.role;
  if (role !== 'admin' && role !== 'staff') return json({ error: 'role must be "admin" or "staff"' }, 400, request);

  const sql = db();
  try {
    const membership = await getMembership(sql, session.userCuid);
    if (membership && membership.role !== 'admin') {
      return json({ error: 'Only the account owner or an admin can invite team members' }, 403, request);
    }
    const orgOwnerCuid = membership ? membership.orgOwnerCuid : session.userCuid;

    const [owner] = await sql`select plan, team_seats from users where cuid = ${orgOwnerCuid}`;
    if (!owner) return json({ error: 'Account not found' }, 404, request);
    if (owner.plan !== 'team') return json({ error: 'Inviting team members needs a Team plan' }, 402, request);

    // Informational check — the authoritative one happens again at
    // redemption time (api/team-join.js), since several invite links can
    // be outstanding at once and seats could fill up between now and
    // whenever any one of them is actually accepted.
    const memberRows = await sql`select cuid from team_members where org_owner_cuid = ${orgOwnerCuid}`;
    const seatsUsed = memberRows.length + 1; // +1 for the owner, who is never a team_members row
    if (owner.team_seats != null && seatsUsed >= owner.team_seats) {
      return json({ error: 'All purchased seats are already in use — add more seats first.', code: 'seats_full' }, 409, request);
    }

    const token = await signInviteToken({ orgOwnerCuid, role }, secret);
    return json({ token, inviteUrl: `${APP_ORIGIN}/login.html?teamInvite=${encodeURIComponent(token)}` }, 200, request);
  } catch (err) {
    console.error('team-invite handler error', err.message);
    return json({ error: 'Could not create an invite' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
