/* Sidekick — api/booking-availability.js
 *
 * Public, unauthenticated by design — this is what the self-service
 * booking page (app/book.html) reads to show one freelancer's services and
 * open slots. No client login — has to work for a stranger who has never
 * touched Sidekick.
 *
 * Generic multi-tenant (2026-07-14): requires ?u=<user_cuid>, identifying
 * which account's public booking page this is. `services` now reads the
 * account's own real Service catalog (sql/schema-core.sql's `services`
 * table, shared with the rest of the app — no separate booking-only
 * services list anymore, unlike the old single-tenant pilot).
 *
 * Treats an expired hold as available again on read, rather than needing a
 * cron job to sweep them — see booking-request.js for where holds are set.
 */
import { db } from '../lib/db.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, request);

  const userCuid = new URL(request.url).searchParams.get('u');
  if (!userCuid) return json({ error: 'Missing ?u=' }, 400, request);

  try {
    const sql = db();
    const [services, slots] = await Promise.all([
      sql(
        `select cuid, name, rate, unit from services
         where user_cuid = $1
           -- 2026-07-17: Pass M3-L1 — products are invoiceable, not bookable.
           and coalesce(kind, 'service') <> 'product'
         order by name`,
        [userCuid]
      ),
      sql(
        `select id, starts_at, ends_at
         from availability_slots
         where user_cuid = $1
           and (status = 'open' or (status = 'held' and hold_expires_at < now()))
         order by starts_at`,
        [userCuid]
      ),
    ]);
    return json({ services, slots }, 200, request);
  } catch (err) {
    console.error('booking-availability handler error', err.message);
    return json({ error: 'Could not load availability' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
