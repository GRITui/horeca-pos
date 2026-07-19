/* Sidekick — api/team-join.js
 *
 * Redeems an invite token (api/team-invite.js) into a real team_members
 * row for whichever account is currently logged in when the invite link
 * is opened — see app/login.html's ?teamInvite= handling for how a
 * logged-out visitor gets to a login/register step first.
 *
 * Known gap, deliberately not solved here: an account that had its own
 * pre-existing solo data (local and/or already cloud-backed-up) before
 * joining a team keeps that data under its own user_cuid, which becomes
 * unreachable through the app the moment resolveDataOwner() starts
 * resolving them to the org owner instead — there's no merge/import step.
 * Fine for a brand-new account created specifically to join a team; a
 * real gap for someone converting an established solo account. Flagged as
 * a follow-up, not attempted this pass.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { getMembership, verifyInviteToken } from '../lib/teams.js';
import { rateLimit } from '../lib/rateLimit.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  // Best-effort per-instance rate limit (see lib/rateLimit.js's honest
  // limitation note): bounds brute-force attempts against invite-token signatures.
  const limited = rateLimit(request, { key: 'team-join', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const body = await request.json().catch(() => null);
  const token = body && body.token;
  if (!token) return json({ error: 'Missing token' }, 400, request);

  const invite = await verifyInviteToken(token, secret);
  if (!invite) return json({ error: 'This invite link is invalid or has expired.', code: 'invalid_invite' }, 400, request);
  if (invite.orgOwnerCuid === session.userCuid) {
    return json({ error: "You can't join your own team." }, 400, request);
  }

  const sql = db();
  try {
    const existing = await getMembership(sql, session.userCuid);
    if (existing) {
      return json({ error: existing.orgOwnerCuid === invite.orgOwnerCuid
        ? "You're already a member of this team."
        : 'Your account already belongs to a different team — leave it first.', code: 'already_member' }, 409, request);
    }
    const [me] = await sql`select plan from users where cuid = ${session.userCuid}`;
    if (me && me.plan === 'team') {
      return json({ error: 'A Team-plan account can\'t also join another team — downgrade your own plan first.', code: 'is_owner' }, 409, request);
    }

    const [owner] = await sql`select plan, team_seats from users where cuid = ${invite.orgOwnerCuid}`;
    if (!owner || owner.plan !== 'team') {
      return json({ error: 'This team is no longer active.', code: 'invalid_invite' }, 400, request);
    }
    const memberRows = await sql`select cuid from team_members where org_owner_cuid = ${invite.orgOwnerCuid}`;
    const seatsUsed = memberRows.length + 1; // +1 for the owner
    if (owner.team_seats != null && seatsUsed >= owner.team_seats) {
      return json({ error: 'All purchased seats are already in use — ask the team owner to add more.', code: 'seats_full' }, 409, request);
    }

    await sql`insert into team_members (cuid, org_owner_cuid, member_cuid, role) values (${crypto.randomUUID()}, ${invite.orgOwnerCuid}, ${session.userCuid}, ${invite.role})`;
    return json({ joined: true, role: invite.role, orgOwnerCuid: invite.orgOwnerCuid }, 200, request);
  } catch (err) {
    console.error('team-join handler error', err.message);
    return json({ error: 'Could not join the team' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
