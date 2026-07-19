/* Sidekick — api/order-requests.js
 *
 * The freelancer's side of Pass M3-L3's public storefront — the missing
 * half of api/shop-public.js (public, unauthenticated): that endpoint
 * writes `order_requests` as status='requested' with a server-repriced
 * items snapshot; this is what lets the freelancer see them and move one
 * to 'confirmed'/'declined'. GET lists the account's pending requests;
 * POST confirms or declines one.
 *
 * Unlike api/booking-requests.js, there is no scarce slot to race for — an
 * order request holds no stock (see sql/schema-core.sql's order_requests
 * comment on why v1 accepts oversell risk instead), so confirm is a plain
 * atomic status flip, not a two-resource update. The same
 * `where id = $1 and user_cuid = $2 and status = 'requested'` conditional
 * UPDATE technique booking-requests.js already uses is still what makes a
 * double-tap on Confirm (or two racing tabs) safe: a single statement with
 * the current state in its own WHERE clause is atomic in Postgres on its
 * own — a second confirm attempt matches zero rows and gets a 409, never a
 * second pipeline job created client-side from the same request.
 *
 * Confirm itself doesn't create the pipeline job — that happens
 * client-side (app/app.js's resolveOrderRequest / createLocalJobFromOrder-
 * Request), the same division of labor api/booking-requests.js's confirm
 * has with app.js's createLocalBookingFromLineRequest: the server only
 * ever owns order_requests' own status, never the local-first `jobs`
 * store.
 *
 * Factory shape (opts.getSql) matches api/booking-requests.js's seam, so
 * tests/test-shop-public.mjs can swap in an in-memory fake sql without a
 * live Neon connection.
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

export function createOrderRequestsHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);

    const sql = getSql();
    // A team member (admin/staff) manages the org owner's order requests,
    // same data-owner resolution as api/booking-requests.js/lib/crudHandler.js.
    const owner = await resolveDataOwner(sql, session.userCuid);

    try {
      if (request.method === 'GET') {
        const rows = await sql(
          `select id, client_name, contact, items, total, created_at
           from order_requests
           where user_cuid = $1 and status = 'requested'
           order by created_at desc`,
          [owner]
        );
        return json({
          rows: rows.map(r => ({
            id: r.id,
            clientName: r.client_name,
            contact: r.contact,
            items: r.items || [],
            total: r.total,
            createdAt: r.created_at,
          })),
        }, 200, request);
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const id = body ? Number(body.id) : NaN;
        const action = body && body.action;
        if (!Number.isInteger(id) || (action !== 'confirm' && action !== 'decline')) {
          return json({ error: "id and action ('confirm' or 'decline') are required" }, 400, request);
        }

        // Same write-lock gate as lib/crudHandler.js/api/booking-requests.js,
        // checked against the resolved data owner: a locked account is
        // read-only.
        const [user] = await sql(
          `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
          [owner]
        );
        if (!canWrite(user)) {
          return json({ error: 'Subscription required', code: 'locked' }, 402, request);
        }

        const status = action === 'confirm' ? 'confirmed' : 'declined';
        // The atomic flip — see header comment. Covers both "unknown id"
        // and "already resolved" with the same 409, deliberately: neither
        // case has anything left for the caller to act on beyond
        // refreshing its own pending list.
        const [row] = await sql(
          `update order_requests set status = $1
           where id = $2 and user_cuid = $3 and status = 'requested'
           returning id, client_name, contact, items, total, created_at`,
          [status, id, owner]
        );
        if (!row) return json({ error: 'Not found or already resolved' }, 409, request);

        return json({
          ok: true,
          status,
          order: {
            id: row.id,
            clientName: row.client_name,
            contact: row.contact,
            items: row.items || [],
            total: row.total,
            createdAt: row.created_at,
          },
        }, 200, request);
      }

      return json({ error: 'Method not allowed' }, 405, request);
    } catch (err) {
      console.error('order-requests handler error', err.message);
      return json({ error: 'Request failed' }, 502, request);
    }
  };
}

export default createOrderRequestsHandler();
export const config = { runtime: 'edge' };
