/* Grit Taskboard — api/grit-org-link.js
 *
 * Authed GET/PUT/DELETE of the calling account's grit_org_links row — the
 * 1:1 mapping between this taskboard account and a Grit BizSuite
 * organization id (an opaque string owned by the platform side; this app
 * never validates it beyond "non-empty string"). api/grit-events.js's
 * webhook handler reads this same table to route an inbound event to the
 * right account.
 *
 * Same auth/row-scoping shape as lib/crudHandler.js: bearer session
 * (lib/auth.js) resolved to a data-owner cuid (lib/teams.js
 * resolveDataOwner — a team member manages the org owner's link, not their
 * own), never a client-supplied cuid. Not built on createResourceHandler
 * because this resource has no `cuid` column of its own and is keyed
 * 1:1 by user_cuid instead (see sql/schema-core.sql's grit_org_links
 * comment) — GET/PUT/DELETE all operate on "the" row, no ?cuid= needed.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { resolveDataOwner } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export function createGritOrgLinkHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);

    const sql = getSql();
    const owner = await resolveDataOwner(sql, session.userCuid);

    try {
      if (request.method === 'GET') {
        const [row] = await sql(
          `select organization_id, created_at from grit_org_links where user_cuid = $1`,
          [owner]
        );
        return json({ link: row || null }, 200, request);
      }

      if (request.method === 'PUT') {
        const body = await request.json().catch(() => null);
        const organizationId = body && typeof body.organization_id === 'string' ? body.organization_id.trim() : '';
        if (!organizationId) return json({ error: 'Missing organization_id' }, 400, request);

        let rows;
        try {
          rows = await sql(
            `insert into grit_org_links (user_cuid, organization_id, created_at)
             values ($1, $2, now())
             on conflict (user_cuid) do update set organization_id = excluded.organization_id
             returning organization_id, created_at`,
            [owner, organizationId]
          );
        } catch (err) {
          // The `on conflict` clause above only covers a conflict on
          // user_cuid (this account already had a link) — organization_id's
          // OWN unique constraint has no target here, so re-linking an
          // organization id another account already claimed raises a plain
          // unique-violation instead, caught and translated here.
          if (err && (err.code === '23505' || /organization_id/.test(err.message || ''))) {
            return json({ error: 'That organization is already linked to a different account', code: 'org_already_linked' }, 409, request);
          }
          throw err;
        }
        return json({ link: rows[0] }, 200, request);
      }

      if (request.method === 'DELETE') {
        await sql(`delete from grit_org_links where user_cuid = $1`, [owner]);
        return json({ deleted: true }, 200, request);
      }

      return json({ error: 'Method not allowed' }, 405, request);
    } catch (err) {
      console.error('grit-org-link handler error', err.message);
      return json({ error: 'Request failed' }, 502, request);
    }
  };
}

export default createGritOrgLinkHandler();
export const config = { runtime: 'edge' };
