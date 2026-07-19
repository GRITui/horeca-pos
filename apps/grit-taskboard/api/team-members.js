/* Sidekick — api/team-members.js
 *
 * GET: list the caller's team roster (works whether the caller is the
 * owner or any member — everyone on a team can see who else is on it).
 * DELETE ?memberCuid=<cuid>: remove a member. The owner can remove anyone;
 * an admin can remove staff only (not another admin, not the owner); staff
 * can't call this at all. Removing a member just deletes their
 * team_members row — resolveDataOwner() then falls back to their own
 * cuid on their very next request, handing them back their own
 * (unchanged, still-there) solo account rather than deleting anything.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { getMembership } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const sql = db();
  try {
    const membership = await getMembership(sql, session.userCuid);
    const orgOwnerCuid = membership ? membership.orgOwnerCuid : session.userCuid;
    const myRole = membership ? membership.role : 'owner';

    if (request.method === 'GET') {
      const [owner] = await sql`select cuid, first_name, username from users where cuid = ${orgOwnerCuid}`;
      const members = await sql`
        select u.cuid, u.first_name, u.username, tm.role, tm.joined_at
        from team_members tm join users u on u.cuid = tm.member_cuid
        where tm.org_owner_cuid = ${orgOwnerCuid}
        order by tm.joined_at`;
      return json({
        owner: owner ? { cuid: owner.cuid, name: owner.first_name || owner.username } : null,
        myRole,
        members: members.map(m => ({ cuid: m.cuid, name: m.first_name || m.username, role: m.role, joinedAt: m.joined_at })),
      }, 200, request);
    }

    if (request.method === 'DELETE') {
      if (myRole === 'staff') return json({ error: 'Only the owner or an admin can remove team members' }, 403, request);
      const targetCuid = new URL(request.url).searchParams.get('memberCuid');
      if (!targetCuid) return json({ error: 'Missing ?memberCuid=' }, 400, request);
      if (targetCuid === orgOwnerCuid) return json({ error: "The owner can't be removed — cancel the Team subscription instead." }, 400, request);

      if (myRole === 'admin') {
        const [target] = await sql`select role from team_members where org_owner_cuid = ${orgOwnerCuid} and member_cuid = ${targetCuid}`;
        if (!target || target.role !== 'staff') {
          return json({ error: 'Admins can only remove staff members' }, 403, request);
        }
      }
      const deleted = await sql`delete from team_members where org_owner_cuid = ${orgOwnerCuid} and member_cuid = ${targetCuid} returning member_cuid`;
      if (!deleted.length) return json({ error: 'Not found' }, 404, request);
      return json({ removed: true }, 200, request);
    }

    return json({ error: 'Method not allowed' }, 405, request);
  } catch (err) {
    console.error('team-members handler error', err.message);
    return json({ error: 'Request failed' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
