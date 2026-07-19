/* Grit Taskboard — api/grit-events.js
 *
 * Inbound half of the cross-app event contract (packages/shared-events):
 * the internal webhook grit-inventory (inventory.threshold_breached) and
 * grit-pos (pos.velocity_surge) POST to, turning each into an ops_tasks
 * card. Server-to-server only — deliberately no lib/cors.js wiring, unlike
 * every other api/*.js in this app: a browser never calls this endpoint, so
 * there is no cross-origin caller to grant.
 *
 * Auth is the HMAC signature (lib/gritEvents.js), not a bearer session —
 * this is a different app calling in, not a logged-in taskboard user.
 *
 * Response codes:
 *   - 401  bad/missing/stale signature
 *   - 400  malformed JSON, or an envelope that fails minimal validation
 *   - 202  recognized envelope but an event this app doesn't act on
 *          (unknown event name, or a known-but-irrelevant one e.g.
 *          transaction.completed), OR the organization_id has no linked
 *          taskboard account (grit_org_links) — both are "nothing to do
 *          here", not errors, so Stripe/webhook-style retry storms don't
 *          happen over a condition that will never resolve itself
 *   - 200/201  card created (201) or already existed for this event_id
 *          (200, idempotent replay)
 */
import { db } from '../lib/db.js';
import { verifyGritWebhook, parseGritEvent } from '../lib/gritEvents.js';

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Only these two events ever produce an ops_tasks card — see
// packages/shared-events README's event catalogue ("grit-taskboard" is only
// listed as a consumer for these two).
const HANDLED_EVENTS = new Set(['inventory.threshold_breached', 'pos.velocity_surge']);

function mintTaskId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'evt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Builds the card content for a handled event — the one place the exact
// card copy lives, so api/ops-tasks.js and tests/test-grit-events.mjs never
// have to duplicate this string-building.
function taskFromEvent(envelope) {
  const { event, data } = envelope;
  if (event === 'inventory.threshold_breached') {
    const supplier = data.supplier_name || 'preferred supplier';
    return {
      title: `Restock SKU: ${data.sku} from ${supplier} immediately`,
      description: `Location ${data.location_id}: ${data.quantity_available} available for ${data.product_name} (SKU ${data.sku}), below the reorder threshold of ${data.reorder_threshold}.`,
      priority: 'high',
      triggeredBy: 'system_inventory',
      locationId: data.location_id,
    };
  }
  // event === 'pos.velocity_surge'
  return {
    title: 'Open auxiliary billing terminal lines',
    description: `Location ${data.location_id}: ${data.transactions_in_window} transactions in the last ${data.window_minutes} minutes (surge threshold ${data.threshold}).`,
    priority: 'high',
    triggeredBy: 'system_pos',
    locationId: data.location_id,
  };
}

// Factory shape so tests can swap in an in-memory fake sql without a live
// Neon connection — same opts.getSql seam lib/crudHandler.js established.
export function createGritEventsHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const secret = process.env.GRIT_EVENT_WEBHOOK_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500);

    // Raw, untouched bytes — the signature is computed over the exact body
    // string, same reason api/stripe-webhook.js/api/line-webhook.js read
    // request.text() instead of request.json() before verifying.
    const rawBody = await request.text();
    const signatureHeader = request.headers.get('x-grit-signature');
    const timestampHeader = request.headers.get('x-grit-timestamp');
    const validSignature = verifyGritWebhook({ secret, rawBody, signatureHeader, timestampHeader });
    if (!validSignature) return json({ error: 'Invalid signature' }, 401);

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const envelope = parseGritEvent(body);
    if (!envelope) return json({ error: 'Invalid event envelope' }, 400);

    if (!HANDLED_EVENTS.has(envelope.event)) {
      return json({ ok: true, ignored: true }, 202);
    }

    const sql = getSql();
    try {
      const [link] = await sql(
        `select user_cuid from grit_org_links where organization_id = $1`,
        [envelope.organization_id]
      );
      if (!link) {
        return json({ ok: true, skipped: true, reason: 'unlinked_org' }, 202);
      }

      const { title, description, priority, triggeredBy, locationId } = taskFromEvent(envelope);
      const newId = mintTaskId();
      const inserted = await sql(
        `insert into ops_tasks (id, user_cuid, location_id, title, description, status, priority, triggered_by, source_event_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'todo', $6, $7, $8, now(), now())
         on conflict (source_event_id) do nothing
         returning id`,
        [newId, link.user_cuid, locationId, title, description, priority, triggeredBy, envelope.event_id]
      );
      if (inserted.length) {
        return json({ ok: true, created: true, taskId: inserted[0].id }, 201);
      }
      // Idempotent replay: a card for this event_id already exists — look
      // it up so the caller still gets a taskId back, same as a fresh create.
      const [existing] = await sql(`select id from ops_tasks where source_event_id = $1`, [envelope.event_id]);
      return json({ ok: true, created: false, taskId: existing ? existing.id : null }, 200);
    } catch (err) {
      console.error('grit-events handler error', err.message);
      return json({ error: 'Request failed' }, 502);
    }
  };
}

export default createGritEventsHandler();
export const config = { runtime: 'nodejs' };
