/* Sidekick — api/invoice-public.js
 *
 * Public, unauthenticated by design — the M2b "shareable client-facing
 * invoice page" (app/invoice.html) reads this to show one invoice's
 * details + payment channels, and posts the client's transfer slip back.
 * Same trust model as app/book.html + api/booking-availability.js: an
 * invoice's own 25-char random cuid (app.js's cuid()) IS the capability
 * token — anyone holding the link can view (and attach a slip to) that ONE
 * invoice, nothing else. That's why:
 *   - GET's response is a strict whitelist, never the raw slip images —
 *     a capability-URL holder must not be able to read back what a
 *     PREVIOUS upload (possibly someone else's, if the link leaked)
 *     contained. Only `slipCount` crosses the wire.
 *   - POST never changes invoice status — the freelancer's own "Confirm
 *     payment received" tap (Pass M2a, app/invoices.js) stays the one
 *     auditable payment-confirmed event; a client attaching a slip is a
 *     claim, not a confirmation.
 *
 * Factory shape (opts.getSql) matches api/booking-requests.js's seam, so
 * tests/test-invoice-public.mjs can swap in an in-memory fake sql without a
 * live Neon connection.
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

// A raw phone photo the client sends is downscaled client-side (same
// longest-side-1200px JPEG q0.8 pipeline as the freelancer's own slip
// attach, see app/invoices.js's readSlipFile) before it ever reaches here —
// 2MB of base64 is generous headroom above what that pipeline produces.
const MAX_DATA_URL_CHARS = 2_000_000;
const MAX_SLIPS = 5;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

export function createInvoicePublicHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const sql = getSql();

    if (request.method === 'GET') {
      // Best-effort per-instance limit (lib/rateLimit.js's honest
      // limitation note) — public + unauthenticated, so bounded against a
      // scraping loop the same way booking-availability.js is.
      const limited = rateLimit(request, { key: 'invoice-public-get', limit: 30, windowMs: 60_000 });
      if (limited) return limited;

      const cuid = new URL(request.url).searchParams.get('i');
      // No detail on a missing/unknown token — both look identical to the
      // caller, same as any other capability-URL surface (never confirm
      // "that id doesn't exist" vs "that id isn't yours").
      if (!cuid) return json({ error: 'Not found' }, 404, request);

      try {
        const [row] = await sql(
          `select inv.number, inv.issue_date, inv.due_date, inv.client_name, inv.line_items,
                  inv.subtotal, inv.vat_pct, inv.vat, inv.wht_pct, inv.wht, inv.client_pays,
                  inv.deposit_pct, inv.status, inv.payment_channels, inv.notes, inv.slips,
                  coalesce(u.first_name, u.username) as owner_name
           from invoices inv
           join users u on u.cuid = inv.user_cuid
           where inv.cuid = $1`,
          [cuid]
        );
        if (!row) return json({ error: 'Not found' }, 404, request);

        return json({
          number: row.number,
          issueDate: row.issue_date,
          dueDate: row.due_date,
          clientName: row.client_name,
          lineItems: row.line_items || [],
          subtotal: row.subtotal,
          vatPct: row.vat_pct,
          vat: row.vat,
          whtPct: row.wht_pct,
          wht: row.wht,
          clientPays: row.client_pays,
          depositPct: row.deposit_pct,
          status: row.status,
          paymentChannels: row.payment_channels || [],
          notes: row.notes,
          ownerName: row.owner_name,
          // Never the slips array itself — see file header.
          slipCount: Array.isArray(row.slips) ? row.slips.length : 0,
        }, 200, request);
      } catch (err) {
        console.error('invoice-public GET handler error', err.message);
        return json({ error: 'Could not load invoice' }, 502, request);
      }
    }

    if (request.method === 'POST') {
      // Tighter than GET — this is a write, and a loop here could fill an
      // invoice's slip array (capped at MAX_SLIPS anyway, but no reason to
      // let an attacker burn DB writes getting there).
      const limited = rateLimit(request, { key: 'invoice-public-post', limit: 5, windowMs: 60_000 });
      if (limited) return limited;

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, request);
      }

      const cuid = typeof body.i === 'string' ? body.i : '';
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
      if (!cuid) return json({ error: 'Not found' }, 404, request);
      if (!DATA_URL_RE.test(dataUrl) || dataUrl.length > MAX_DATA_URL_CHARS) {
        return json({ error: 'That does not look like a valid slip image' }, 400, request);
      }

      try {
        const [existing] = await sql(`select slips from invoices where cuid = $1`, [cuid]);
        if (!existing) return json({ error: 'Not found' }, 404, request);

        const slips = Array.isArray(existing.slips) ? existing.slips : [];
        if (slips.length >= MAX_SLIPS) {
          return json({ error: 'This invoice already has the maximum number of slips attached', code: 'slips_full' }, 409, request);
        }

        const nextSlips = [
          ...slips,
          { id: crypto.randomUUID(), dataUrl, at: new Date().toISOString(), source: 'client' },
        ];
        await sql(`update invoices set slips = $1, updated_at = now() where cuid = $2`, [nextSlips, cuid]);

        return json({ ok: true, slipCount: nextSlips.length }, 200, request);
      } catch (err) {
        console.error('invoice-public POST handler error', err.message);
        return json({ error: 'Could not attach slip' }, 502, request);
      }
    }

    return json({ error: 'Method not allowed' }, 405, request);
  };
}

export default createInvoicePublicHandler();
export const config = { runtime: 'edge' };
