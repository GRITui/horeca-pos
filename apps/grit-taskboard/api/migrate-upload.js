/* Sidekick — api/migrate-upload.js
 *
 * The one-time local->server upload for an existing account's IndexedDB
 * data (or a guest converting to a real account — same shape either way).
 * Idempotent by construction: every row already carries the client-minted
 * `cuid` it always had locally, so `on conflict (cuid) do nothing` makes a
 * retried or twice-run upload safe — no duplicate rows, whether that's a
 * dropped connection retried by the same device or a second device
 * uploading its own local set later.
 *
 * Phase 1 only carries `clients` (the one resource this migration slice
 * has an API for) — fanning this out to the rest of the 14 stores in
 * Phase 2 is a matter of adding more arrays to the same request/response
 * shape, not a new endpoint per store.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const CLIENT_FIELDS = ['name', 'phone', 'email', 'tags', 'notes', 'tax_id', 'billing_address', 'member_no'];

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);
  const { userCuid } = session;

  const body = await request.json().catch(() => null);
  const clients = Array.isArray(body?.clients) ? body.clients : [];

  const sql = db();
  try {
    let inserted = 0;
    for (const c of clients) {
      if (typeof c.cuid !== 'string' || !c.cuid) continue; // skip malformed rows, don't fail the whole batch
      const cols = ['cuid', 'user_cuid', ...CLIENT_FIELDS, 'updated_at'];
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      const values = [c.cuid, userCuid, ...CLIENT_FIELDS.map(f => c[f] ?? null), c.updatedAt || new Date().toISOString()];
      const rows = await sql(
        `insert into clients (${cols.join(', ')}) values (${placeholders.join(', ')})
         on conflict (cuid) do nothing
         returning cuid`,
        values
      );
      if (rows.length) inserted += 1;
    }

    const [user] = await sql`
      update users set migrated_at = coalesce(migrated_at, now())
      where cuid = ${userCuid}
      returning migrated_at
    `;

    return json({
      inserted,
      skipped: clients.length - inserted,
      migratedAt: user?.migrated_at ?? null,
    }, 200, request);
  } catch (err) {
    console.error('migrate-upload handler error', err.message);
    return json({ error: 'Could not complete the upload' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
