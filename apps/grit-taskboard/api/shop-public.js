/* Sidekick — api/shop-public.js
 *
 * Public, unauthenticated by design — Pass M3-L3's storefront: a freelancer
 * shares one link (app/shop.html?u=<their cuid>) and a client browses their
 * PRODUCTS (the `kind = 'product'` rows in the same `services` catalog
 * api/booking-availability.js reads for bookable services — see that
 * file's own header for why there's one catalog, not a separate shop-only
 * list), picks quantities, and submits an order request. Same public-read/
 * public-write split as app/book.html + booking-availability.js/
 * booking-request.js: GET is a read-only catalog, POST is the one write
 * path, both unauthenticated — there is no client login to speak of.
 *
 * No payment happens on this page and no stock is held at request time —
 * v1 deliberately accepts oversell risk (see sql/schema-core.sql's
 * order_requests comment): stock only ever decrements once the resulting
 * invoice is confirmed paid (Pass M3-L1's decrementStockForInvoicePaid),
 * exactly like any other sale, once the freelancer confirms this request
 * into a pipeline engagement (api/order-requests.js + app.js) and walks it
 * through quote/invoice like normal.
 *
 * POST never trusts a client-submitted price — every item is repriced from
 * the account's own catalog server-side before it's ever written, the same
 * way a client can never set their own invoice total. The response body
 * never echoes the submitted name/contact back, and never leaks anything
 * SQL/connection-string-shaped, on either success or failure.
 *
 * Factory shape (opts.getSql) matches api/booking-requests.js/api/invoice-
 * public.js's seam, so tests/test-shop-public.mjs can swap in an in-memory
 * fake sql without a live Neon connection.
 */
import { db } from '../lib/db.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { rateLimit } from '../lib/rateLimit.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const MAX_ITEMS = 20;
const MAX_QTY = 999;
const MAX_NAME_CHARS = 120;

export function createShopPublicHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const sql = getSql();

    if (request.method === 'GET') {
      // Best-effort per-instance limit (lib/rateLimit.js's honest
      // limitation note) — public + unauthenticated, bounded against a
      // scraping loop the same way booking-availability.js/invoice-
      // public.js are.
      const limited = rateLimit(request, { key: 'shop-public-get', limit: 30, windowMs: 60_000 });
      if (limited) return limited;

      const userCuid = new URL(request.url).searchParams.get('u');
      // No detail on a missing/unknown account — same capability-URL-
      // shaped trust boundary as api/invoice-public.js's `i` token (never
      // confirm "that account doesn't exist" vs "that account isn't a
      // shop" to a prober).
      if (!userCuid) return json({ error: 'Not found' }, 404, request);

      try {
        const [owner] = await sql(
          `select coalesce(first_name, username) as owner_name from users where cuid = $1`,
          [userCuid]
        );
        if (!owner) return json({ error: 'Not found' }, 404, request);

        const rows = await sql(
          `select cuid, name, unit, rate, sku, stock_qty from services
           where user_cuid = $1
             and coalesce(kind, 'service') = 'product'
             and (stock_qty is null or stock_qty > 0)
           order by name`,
          [userCuid]
        );

        return json({
          ownerName: owner.owner_name,
          products: rows.map(r => ({
            cuid: r.cuid, name: r.name, unit: r.unit, rate: r.rate, sku: r.sku, stockQty: r.stock_qty,
          })),
        }, 200, request);
      } catch (err) {
        console.error('shop-public GET handler error', err.message);
        return json({ error: 'Could not load shop' }, 502, request);
      }
    }

    if (request.method === 'POST') {
      // Tighter than GET — this is a write, and a loop here would insert
      // junk order_requests rows into the freelancer's Settings inbox.
      const limited = rateLimit(request, { key: 'shop-public-post', limit: 5, windowMs: 60_000 });
      if (limited) return limited;

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, request);
      }

      const userCuid = typeof body.u === 'string' ? body.u : '';
      const clientName = typeof body.name === 'string' ? body.name.trim() : '';
      const contact = typeof body.contact === 'string' && body.contact.trim() ? body.contact.trim().slice(0, 200) : null;
      const items = Array.isArray(body.items) ? body.items : null;

      if (!userCuid) return json({ error: 'Not found' }, 404, request);
      if (!clientName || clientName.length > MAX_NAME_CHARS) {
        return json({ error: 'Your name is required' }, 400, request);
      }
      if (!items || items.length === 0 || items.length > MAX_ITEMS) {
        return json({ error: 'Pick at least one item' }, 400, request);
      }
      const requestedCuids = [];
      for (const it of items) {
        const itCuid = it && typeof it.cuid === 'string' ? it.cuid : '';
        const qty = it ? Number(it.qty) : NaN;
        if (!itCuid || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
          return json({ error: 'Each item needs a valid quantity (1–999)' }, 400, request);
        }
        requestedCuids.push(itCuid);
      }

      try {
        // Loads the whole account's product catalog rather than an
        // `= any(...)` array-param lookup — this codebase's sql() calls
        // never use array params elsewhere (see this file's own PR notes),
        // and a shop's catalog is small enough that this is simpler and
        // just as correct: every requested cuid is checked against it
        // below, and ANY cuid that isn't in the account's own product
        // catalog rejects the whole request — never a partial/best-effort
        // order — so the client-shown total and the stored total can never
        // disagree.
        const catalog = await sql(
          `select cuid, name, rate from services
           where user_cuid = $1 and coalesce(kind, 'service') = 'product'`,
          [userCuid]
        );
        const byCuid = new Map(catalog.map(r => [r.cuid, r]));
        if (requestedCuids.some(c => !byCuid.has(c))) {
          return json({ error: 'One or more items are no longer available' }, 400, request);
        }

        let total = 0;
        const snapshot = items.map(it => {
          const svc = byCuid.get(it.cuid);
          const qty = Number(it.qty);
          // Repriced from the catalog — the client-submitted price (if any
          // was even sent) is never read or trusted.
          const unitPrice = Number(svc.rate) || 0;
          total += qty * unitPrice;
          return { service_cuid: svc.cuid, name: svc.name, qty, unit_price: unitPrice };
        });

        await sql(
          `insert into order_requests (user_cuid, client_name, contact, items, total, status)
           values ($1, $2, $3, $4, $5, 'requested')`,
          [userCuid, clientName, contact, snapshot, total]
        );

        // Never echoes name/contact/items back — see file header.
        return json({ ok: true }, 200, request);
      } catch (err) {
        console.error('shop-public POST handler error', err.message);
        return json({ error: 'Could not submit order' }, 502, request);
      }
    }

    return json({ error: 'Method not allowed' }, 405, request);
  };
}

export default createShopPublicHandler();
export const config = { runtime: 'edge' };
