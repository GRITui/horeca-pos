/* Grit Taskboard — api/ops-tasks.js
 *
 * Authed CRUD for the ops kanban (ops_tasks table). Same auth/row-scoping
 * shape as lib/crudHandler.js's resource endpoints (bearer session ->
 * resolveDataOwner -> user_cuid, never a client-supplied owner field), but
 * hand-rolled rather than createResourceHandler: this resource needs a few
 * things that factory doesn't support — ?status=/?since= list filters,
 * completed_at bookkeeping on a status transition, and firing a
 * task.completed event (packages/shared-events/src/contracts.ts
 * TaskCompletedData) when a card reaches 'done'. Response rows are raw
 * `select *` output (snake_case columns), same convention every other
 * resource endpoint here uses — app/dataClient.js does the camelCase
 * mapping client-side (fromOpsTaskRow), not this file.
 *
 * `triggered_by` is never client-writable: POST always creates 'manual'
 * cards; 'system_inventory'/'system_pos' cards only ever come from
 * api/grit-events.js's webhook intake.
 *
 * GET also accepts a second, service-to-service auth path (GRIT_SERVICE_TOKEN
 * bearer + ?organization_id=, resolved via grit_org_links) for grit-reports'
 * cross-app aggregator — see createOpsTasksHandler's GET branch for the full
 * rationale. POST/PUT/DELETE remain session-only. The `?status=done&since=`
 * combination filters on completed_at, not updated_at (see listOpsTasks) —
 * every other filter combination is unchanged.
 */
import { db } from '../lib/db.js';
import { requireSession, constantTimeEqual } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { canWrite } from '../lib/entitlements.js';
import { resolveDataOwner } from '../lib/teams.js';
import { rateLimit } from '../lib/rateLimit.js';
import { signGritWebhook } from '../lib/gritEvents.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const STATUSES = new Set(['todo', 'in_progress', 'review', 'done']);
const PRIORITIES = new Set(['low', 'normal', 'high']);

function mintTaskId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Best-effort, from the caller's point of view (a downed/misconfigured
// subscriber must never fail or roll back the task-completion write
// itself) — but actually awaited here, not truly backgrounded: Vercel
// serverless functions have no guaranteed execution past the point a
// response is returned, so "fire-and-forget" without awaiting would often
// mean "never sent" rather than "sent, response not watched". Callers wrap
// this in .catch(() => {}) as well, for the same reason lib/db.js callers
// elsewhere never let a mirror/notify step's own rejection propagate.
async function emitTaskCompleted(sql, owner, task) {
  const subscribers = (process.env.GRIT_SUBSCRIBERS_TASK_COMPLETED || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!subscribers.length) return;
  const secret = process.env.GRIT_EVENT_WEBHOOK_SECRET;
  if (!secret) return; // nothing safe to sign with — skip silently, same posture as an unset optional env var elsewhere in this app

  const [link] = await sql(`select organization_id from grit_org_links where user_cuid = $1`, [owner]);
  if (!link) return; // no linked org to attribute this event to — skip silently, mirrors api/grit-events.js's own unlinked-org skip

  // TaskCompletedData.location_id is a required non-empty string in
  // packages/shared-events/src/contracts.ts (and its plain-JS mirror,
  // lib/gritEvents.js's DATA_VALIDATORS['task.completed'] would carry the
  // same rule if this app validated its own outbound data) — but
  // ops_tasks.location_id is nullable (a manually created card need not
  // have one, see the POST handler above). Sending a null here would
  // produce an envelope every spec-following subscriber's parseGritEvent
  // rejects outright, so skip silently rather than deliver a
  // contract-violating event, same posture as the two skips above.
  if (!task.location_id) return;

  const envelope = {
    event: 'task.completed',
    timestamp: new Date().toISOString(),
    event_id: mintTaskId(),
    organization_id: link.organization_id,
    data: {
      task_id: task.id,
      location_id: task.location_id,
      title: task.title,
      triggered_by: task.triggered_by,
      assigned_shift: task.assigned_shift,
      created_at: task.created_at,
      completed_at: task.completed_at,
    },
  };
  const rawBody = JSON.stringify(envelope);
  const headers = signGritWebhook(secret, 'task.completed', rawBody);

  await Promise.allSettled(subscribers.map(url =>
    fetch(url, { method: 'POST', headers, body: rawBody }).catch(err => {
      console.error('ops-tasks task.completed delivery failed', url, err.message);
    })
  ));
}

// Shared by both GET auth paths below (session-scoped and service-token/
// organization_id-scoped) so the filter semantics never drift between them.
// Returns { rows } on success or { error } for a 400-worthy bad filter —
// never throws on a bad *filter value* (a DB failure still propagates, same
// as every other query in this file, so the caller's try/catch handles it).
async function listOpsTasks(sql, owner, url) {
  const status = url.searchParams.get('status');
  const since = url.searchParams.get('since');
  if (status && !STATUSES.has(status)) return { error: 'Invalid status filter' };
  if (since && Number.isNaN(Date.parse(since))) return { error: 'Invalid since filter' };

  const conditions = ['user_cuid = $1'];
  const params = [owner];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (since) {
    params.push(since);
    // aggregate-labor.js's "completion speed since <from>" semantics
    // (apps/grit-reports/api/aggregate-labor.js: `?status=done&since=<from>`)
    // want tasks that *completed* on or after `since`, not tasks merely
    // *touched* since then — filtering on updated_at here would wrongly
    // pull in a long-done card that only got a later, unrelated edit (e.g.
    // a title fix months after completion), skewing the completion-speed
    // window. Every other query (no status filter, or a non-done status)
    // keeps updated_at semantics — a not-done task has no completed_at to
    // filter on anyway, and "recently touched" is the meaning callers of a
    // live/in-progress filter actually want.
    const sinceColumn = status === 'done' ? 'completed_at' : 'updated_at';
    conditions.push(`${sinceColumn} >= $${params.length}`);
  }

  const rows = await sql(
    `select * from ops_tasks where ${conditions.join(' and ')} order by updated_at desc`,
    params
  );
  return { rows };
}

export function createOpsTasksHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const sql = getSql();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    // Service-token GET path — grit-reports' labor aggregator
    // (apps/grit-reports/api/aggregate-labor.js) calls this endpoint
    // server-to-server, with no taskboard session of its own. Mirrors
    // grit-pos's app/api/reports/revenue/route.ts resolveTenantId: a
    // bearer token that timing-safe-equals GRIT_SERVICE_TOKEN authenticates
    // as "service", scoped by an explicit ?organization_id= (resolved via
    // grit_org_links) instead of a session-derived owner. GET only —
    // POST/PUT/DELETE stay session-only below, a service caller never
    // writes taskboard state.
    //
    // Unlike route.ts's cookie-vs-bearer split, this app's OWN session auth
    // (lib/auth.js) already uses "Authorization: Bearer <token>" for real
    // users too, so a non-matching bearer must NOT fail closed here — it
    // simply isn't a service call, and falls through to the normal session
    // check below, which fails it on its own terms (401 for a
    // malformed/unrecognized token). Only an env-set + exact-match token
    // short-circuits into the service path; with GRIT_SERVICE_TOKEN unset,
    // this whole branch is inert and every GET goes through session auth
    // exactly as before.
    if (request.method === 'GET') {
      const serviceToken = process.env.GRIT_SERVICE_TOKEN;
      if (serviceToken) {
        const header = request.headers.get('authorization') || '';
        const m = /^Bearer\s+(.+)$/i.exec(header);
        if (m && constantTimeEqual(m[1], serviceToken)) {
          try {
            const organizationId = url.searchParams.get('organization_id');
            if (!organizationId) return json({ error: 'Missing organization_id' }, 400, request);

            const [link] = await sql(
              `select user_cuid from grit_org_links where organization_id = $1`,
              [organizationId]
            );
            // Unknown/unlinked org is not an error — the org may simply
            // not have connected a taskboard account yet, same posture as
            // api/grit-events.js's 202-skip for an inbound event with an
            // unlinked organization_id. A service caller gets a normal 200
            // with an empty list, not a 404/403 that would make a
            // perfectly valid "not connected" state look like a bug to the
            // aggregator.
            if (!link) return json({ rows: [] }, 200, request);

            const result = await listOpsTasks(sql, link.user_cuid, url);
            if (result.error) return json({ error: result.error }, 400, request);
            return json({ rows: result.rows }, 200, request);
          } catch (err) {
            console.error('ops-tasks handler error (service auth)', err.message);
            return json({ error: 'Request failed' }, 502, request);
          }
        }
      }
    }

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);

    const owner = await resolveDataOwner(sql, session.userCuid);

    try {
      if (request.method === 'GET') {
        const result = await listOpsTasks(sql, owner, url);
        if (result.error) return json({ error: result.error }, 400, request);
        return json({ rows: result.rows }, 200, request);
      }

      // Cheap-for-attacker but authenticated write path — a lighter cap
      // than the public/unauthenticated endpoints elsewhere in this app,
      // just enough to blunt a runaway client-side sync loop.
      const limited = rateLimit(request, { key: 'ops-tasks-write', limit: 60, windowMs: 60_000 });
      if (limited) return limited;

      // Same write-lock gate as lib/crudHandler.js — a locked account
      // (trial expired / past_due / canceled) can still read its board,
      // just can't write to it.
      const [user] = await sql(
        `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
        [owner]
      );
      if (!canWrite(user)) {
        return json({ error: 'Subscription required', code: 'locked' }, 402, request);
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.id !== 'string' || !body.id) return json({ error: 'Missing id' }, 400, request);
        if (typeof body.title !== 'string' || !body.title.trim()) return json({ error: 'Missing title' }, 400, request);
        const status = body.status && STATUSES.has(body.status) ? body.status : 'todo';
        const priority = body.priority && PRIORITIES.has(body.priority) ? body.priority : 'normal';
        const completedAt = status === 'done' ? new Date().toISOString() : null;

        const rows = await sql(
          `insert into ops_tasks (id, user_cuid, location_id, title, description, status, priority, triggered_by, assigned_shift, created_at, updated_at, completed_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, now(), now(), $9)
           on conflict (id) do nothing
           returning *`,
          [body.id, owner, body.location_id ?? null, body.title.trim(), body.description ?? null,
            status, priority, body.assigned_shift ?? null, completedAt]
        );
        if (!rows.length) return json({ error: 'A task with this id already exists' }, 409, request);
        const row = rows[0];
        if (row.status === 'done') await emitTaskCompleted(sql, owner, row).catch(() => {});
        return json({ row }, 201, request);
      }

      if (request.method === 'PUT') {
        if (!id) return json({ error: 'Missing ?id=' }, 400, request);
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'Invalid body' }, 400, request);

        const [existing] = await sql(`select * from ops_tasks where id = $1 and user_cuid = $2`, [id, owner]);
        if (!existing) return json({ error: 'Not found' }, 404, request);

        const cols = [];
        const params = [id, owner];
        const set = (col, value) => { params.push(value); cols.push(`${col} = $${params.length}`); };

        if (Object.prototype.hasOwnProperty.call(body, 'title')) {
          if (typeof body.title !== 'string' || !body.title.trim()) return json({ error: 'Invalid title' }, 400, request);
          set('title', body.title.trim());
        }
        if (Object.prototype.hasOwnProperty.call(body, 'description')) set('description', body.description ?? null);
        if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
          if (!PRIORITIES.has(body.priority)) return json({ error: 'Invalid priority' }, 400, request);
          set('priority', body.priority);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'assigned_shift')) set('assigned_shift', body.assigned_shift ?? null);
        if (Object.prototype.hasOwnProperty.call(body, 'location_id')) set('location_id', body.location_id ?? null);

        // Status transitions: entering 'done' stamps completed_at; leaving
        // 'done' for anything else (the kanban's regress affordance) clears
        // it — only when `status` is actually part of THIS update, never as
        // a side effect of an unrelated field edit made after completion.
        let justCompleted = false;
        if (Object.prototype.hasOwnProperty.call(body, 'status')) {
          if (!STATUSES.has(body.status)) return json({ error: 'Invalid status' }, 400, request);
          set('status', body.status);
          if (body.status === 'done' && existing.status !== 'done') {
            justCompleted = true;
            set('completed_at', new Date().toISOString());
          } else if (body.status !== 'done' && existing.status === 'done') {
            set('completed_at', null);
          }
        }

        if (!cols.length) return json({ error: 'No updatable fields provided' }, 400, request);
        const rows = await sql(
          `update ops_tasks set ${cols.join(', ')}, updated_at = now()
           where id = $1 and user_cuid = $2
           returning *`,
          params
        );
        if (!rows.length) return json({ error: 'Not found' }, 404, request);
        const row = rows[0];
        if (justCompleted) await emitTaskCompleted(sql, owner, row).catch(() => {});
        return json({ row }, 200, request);
      }

      if (request.method === 'DELETE') {
        if (!id) return json({ error: 'Missing ?id=' }, 400, request);
        const rows = await sql(`delete from ops_tasks where id = $1 and user_cuid = $2 returning id`, [id, owner]);
        if (!rows.length) return json({ error: 'Not found' }, 404, request);
        return json({ deleted: true }, 200, request);
      }

      return json({ error: 'Method not allowed' }, 405, request);
    } catch (err) {
      console.error('ops-tasks handler error', err.message);
      return json({ error: 'Request failed' }, 502, request);
    }
  };
}

export default createOpsTasksHandler();
export const config = { runtime: 'nodejs' };
