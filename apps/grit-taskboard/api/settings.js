/* Sidekick — api/settings.js
 *
 * Deliberately NOT a createResourceHandler('settings', FIELDS) call, unlike
 * every other Phase 2 resource. lib/crudHandler.js's shared factory is built
 * entirely around a `cuid` primary key (POST requires body.cuid; PUT/DELETE
 * address a row via ?cuid=) — a shape that fits the other 10 resources
 * exactly, because their IndexedDB records already are cuid-keyed today.
 * `settings` is the one store that isn't: the client's own saveSetting(key,
 * val) already treats it as one-key-at-a-time, and sql/schema-core.sql
 * gives this table a real primary key of (user_cuid, key), with no `cuid`
 * column at all. Forcing that composite-keyed shape through the generic
 * factory would mean adding a meaningless synthetic `cuid` column just to
 * satisfy it — this small bespoke handler is the more honest fit, and it
 * leaves lib/crudHandler.js (and every resource already built on it)
 * completely untouched.
 *
 * GET            -> list every {key, value} row the caller owns.
 * PUT  ?key=<k>  body: {value} -> upsert (update-if-exists else insert),
 *                matching saveSetting()'s own overwrite-blindly semantics.
 * DELETE ?key=<k> -> remove one key.
 *
 * Same no-body-in-logs discipline as lib/crudHandler.js's catch block: this
 * store carries PII-adjacent plaintext today (PromptPay IDs, tax IDs in
 * paymentChannels/sellerTaxId), so a failed request only ever logs
 * `err.message`, never the request body or the value itself.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { canWrite } from '../lib/entitlements.js';
import { resolveDataOwner } from '../lib/teams.js';

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
  const userCuid = await resolveDataOwner(sql, session.userCuid);
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  try {
    if (request.method === 'GET') {
      const rows = await sql(
        'select key, value, updated_at from settings where user_cuid = $1 order by key',
        [userCuid]
      );
      return json({ rows }, 200, request);
    }

    // Same write-lock gate lib/crudHandler.js applies to every other
    // resource (a locked account is read-only, not fully shut out) — found
    // missing here while wiring in team resolution above; this bespoke
    // handler predates that gate and never got it added. Reads (GET above)
    // still stay open regardless, matching the rest of the app.
    if (request.method === 'PUT' || request.method === 'DELETE') {
      const [user] = await sql(`select plan, subscription_status, trial_ends_at from users where cuid = $1`, [userCuid]);
      if (!canWrite(user)) return json({ error: 'Subscription required', code: 'locked' }, 402, request);
    }

    if (request.method === 'PUT') {
      if (!key) return json({ error: 'Missing ?key=' }, 400, request);
      const body = await request.json().catch(() => null);
      if (!body || !Object.prototype.hasOwnProperty.call(body, 'value')) {
        return json({ error: 'Missing value' }, 400, request);
      }
      const value = body.value ?? null;

      const updated = await sql(
        `update settings set value = $3, updated_at = now()
         where user_cuid = $1 and key = $2
         returning key, value, updated_at`,
        [userCuid, key, value]
      );
      if (updated.length) return json({ row: updated[0] }, 200, request);

      const inserted = await sql(
        `insert into settings (user_cuid, key, value, updated_at) values ($1, $2, $3, $4)
         returning key, value, updated_at`,
        [userCuid, key, value, new Date().toISOString()]
      );
      return json({ row: inserted[0] }, 201, request);
    }

    if (request.method === 'DELETE') {
      if (!key) return json({ error: 'Missing ?key=' }, 400, request);
      const rows = await sql(
        'delete from settings where user_cuid = $1 and key = $2 returning key',
        [userCuid, key]
      );
      if (!rows.length) return json({ error: 'Not found' }, 404, request);
      return json({ deleted: true }, 200, request);
    }

    return json({ error: 'Method not allowed' }, 405, request);
  } catch (err) {
    console.error('settings handler error', err.message);
    return json({ error: 'Request failed' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
