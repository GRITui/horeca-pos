// Grit Taskboard — api/ops-tasks.js's GET auth paths and list filters,
// against an in-memory fake sql. Same style as tests/test-grit-events.mjs
// (fake sql + factory handler) and tests/test-booking-confirm.mjs
// (signed-session bearer auth via lib/auth.js's signSession).
//
// Covers:
//   - service-token GET path (GRIT_SERVICE_TOKEN bearer + ?organization_id=):
//     valid token + linked org lists tasks; valid token + unlinked org ->
//     200/empty list; wrong token -> falls through to session auth -> 401;
//     GRIT_SERVICE_TOKEN unset -> path disabled -> session fallback -> 401;
//     missing ?organization_id= with a valid service token -> 400.
//   - the `status=done&since=` completed_at (not updated_at) window filter,
//     exercised through both the service-token and session auth paths, plus
//     a same-`since` non-done query to confirm updated_at semantics are
//     unchanged there.
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GRIT_SERVICE_TOKEN = 'test-service-token';

import { signSession } from '../lib/auth.js';
import { createOpsTasksHandler } from '../api/ops-tasks.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const SESSION_SECRET = process.env.SESSION_SECRET;
const SERVICE_TOKEN = process.env.GRIT_SERVICE_TOKEN;
const SINCE = '2026-07-10T00:00:00.000Z';

// ── In-memory tables ────────────────────────────────────────────────────
let orgLinks, opsTasks, teamMembers;
function resetDb() {
  orgLinks = [{ user_cuid: 'owner-1', organization_id: 'org-linked' }];
  opsTasks = [
    // done, but only *touched* (updated_at) after SINCE — completed_at is
    // well before it. Must NOT appear in a status=done&since=SINCE query
    // (that's exactly the bug being fixed: a later unrelated edit to an
    // old completed card wrongly pulling it into the completion window).
    {
      id: 't1-old-done-recently-edited', user_cuid: 'owner-1', location_id: 'loc-1',
      title: 'Old done task, recently edited', description: null, status: 'done', priority: 'normal',
      triggered_by: 'manual', assigned_shift: null,
      created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
      completed_at: '2026-06-01T00:00:00.000Z',
    },
    // done, and actually completed after SINCE — must appear.
    {
      id: 't2-recently-done', user_cuid: 'owner-1', location_id: 'loc-1',
      title: 'Recently done task', description: null, status: 'done', priority: 'normal',
      triggered_by: 'manual', assigned_shift: null,
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-12T00:00:00.000Z',
      completed_at: '2026-07-12T00:00:00.000Z',
    },
    // not done, updated after SINCE — must appear in a status=todo&since=
    // query (updated_at semantics unchanged for non-done statuses).
    {
      id: 't3-todo-recently-updated', user_cuid: 'owner-1', location_id: 'loc-1',
      title: 'Todo, recently touched', description: null, status: 'todo', priority: 'normal',
      triggered_by: 'manual', assigned_shift: null,
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-11T00:00:00.000Z',
      completed_at: null,
    },
    // not done, updated before SINCE — must NOT appear in that same query.
    {
      id: 't4-todo-stale', user_cuid: 'owner-1', location_id: 'loc-1',
      title: 'Todo, stale', description: null, status: 'todo', priority: 'normal',
      triggered_by: 'manual', assigned_shift: null,
      created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z',
      completed_at: null,
    },
  ];
  teamMembers = [];
}

function fakeSql(text, params) {
  const t = Array.isArray(text) ? text.join('?') : text;
  const p = Array.isArray(text) ? Array.from(arguments).slice(1) : params;

  if (t.includes('select org_owner_cuid from team_members where member_cuid')) {
    const row = teamMembers.find(m => m.member_cuid === p[0]);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid }] : []);
  }
  if (t.includes('select user_cuid from grit_org_links where organization_id')) {
    const row = orgLinks.find(l => l.organization_id === p[0]);
    return Promise.resolve(row ? [{ user_cuid: row.user_cuid }] : []);
  }
  if (t.trim().startsWith('select * from ops_tasks where')) {
    const owner = p[0];
    let rows = opsTasks.filter(r => r.user_cuid === owner);
    let idx = 1;
    if (t.includes('status = $')) {
      const status = p[idx]; idx++;
      rows = rows.filter(r => r.status === status);
    }
    if (t.includes('completed_at >= $')) {
      const since = p[idx]; idx++;
      rows = rows.filter(r => r.completed_at !== null && r.completed_at >= since);
    } else if (t.includes('updated_at >= $')) {
      const since = p[idx]; idx++;
      rows = rows.filter(r => r.updated_at >= since);
    }
    return Promise.resolve(rows.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }
  throw new Error('unexpected query in fakeSql: ' + t);
}

const handler = createOpsTasksHandler({ getSql: () => fakeSql });

function get(path, headers = {}) {
  return handler(new Request(`https://x${path}`, { method: 'GET', headers }));
}

async function main() {
  // ── service-token GET path: valid token + linked org lists tasks ───────
  resetDb();
  {
    const res = await get('/api/ops-tasks?organization_id=org-linked', { authorization: `Bearer ${SERVICE_TOKEN}` });
    const data = await res.json();
    assert(res.status === 200, 'service token + linked org: 200');
    assert(Array.isArray(data.rows) && data.rows.length === opsTasks.length, 'service token + linked org: lists every task for the linked owner');
  }

  // ── service-token GET path: valid token + unlinked org -> empty list ───
  resetDb();
  {
    const res = await get('/api/ops-tasks?organization_id=org-unknown', { authorization: `Bearer ${SERVICE_TOKEN}` });
    const data = await res.json();
    assert(res.status === 200, 'service token + unlinked org: 200, not an error');
    assert(Array.isArray(data.rows) && data.rows.length === 0, 'service token + unlinked org: empty rows');
  }

  // ── service-token GET path: missing ?organization_id= -> 400 ───────────
  resetDb();
  {
    const res = await get('/api/ops-tasks', { authorization: `Bearer ${SERVICE_TOKEN}` });
    assert(res.status === 400, 'service token without ?organization_id=: 400');
  }

  // ── wrong token: not a service match, falls through to session auth,
  //    which rejects it too (never a valid signed session) -> 401 ────────
  resetDb();
  {
    const res = await get('/api/ops-tasks?organization_id=org-linked', { authorization: 'Bearer totally-wrong-token' });
    assert(res.status === 401, 'wrong bearer token: falls through to session auth, still 401');
  }

  // ── GRIT_SERVICE_TOKEN unset: service path fully disabled, every GET
  //    goes through session auth -> 401 for a non-session bearer ────────
  resetDb();
  {
    delete process.env.GRIT_SERVICE_TOKEN;
    try {
      const res = await get('/api/ops-tasks?organization_id=org-linked', { authorization: `Bearer ${SERVICE_TOKEN}` });
      assert(res.status === 401, 'GRIT_SERVICE_TOKEN unset: service path disabled, session fallback rejects with 401');
    } finally {
      process.env.GRIT_SERVICE_TOKEN = SERVICE_TOKEN;
    }
  }

  // ── completed_at window filter, via the service-token path ─────────────
  resetDb();
  {
    const res = await get(`/api/ops-tasks?organization_id=org-linked&status=done&since=${encodeURIComponent(SINCE)}`, {
      authorization: `Bearer ${SERVICE_TOKEN}`,
    });
    const data = await res.json();
    assert(res.status === 200, 'status=done&since=: 200');
    const ids = data.rows.map(r => r.id);
    assert(!ids.includes('t1-old-done-recently-edited'), 'a done task completed before `since` but only edited after it is excluded');
    assert(ids.includes('t2-recently-done'), 'a done task actually completed after `since` is included');
    assert(data.rows.length === 1, 'exactly one row matches the done+since window');
  }

  // ── same `since`, non-done status: updated_at semantics unchanged ──────
  resetDb();
  {
    const res = await get(`/api/ops-tasks?organization_id=org-linked&status=todo&since=${encodeURIComponent(SINCE)}`, {
      authorization: `Bearer ${SERVICE_TOKEN}`,
    });
    const data = await res.json();
    const ids = data.rows.map(r => r.id);
    assert(ids.includes('t3-todo-recently-updated'), 'a todo task updated after `since` is included (updated_at semantics)');
    assert(!ids.includes('t4-todo-stale'), 'a todo task updated before `since` is excluded');
  }

  // ── completed_at window filter also holds through ordinary bearer-
  //    session auth (same listOpsTasks() code path, different owner
  //    resolution) — not just the service-token shortcut ─────────────────
  resetDb();
  {
    const token = await signSession({ userCuid: 'owner-1' }, SESSION_SECRET);
    const res = await get(`/api/ops-tasks?status=done&since=${encodeURIComponent(SINCE)}`, {
      authorization: `Bearer ${token}`,
    });
    const data = await res.json();
    assert(res.status === 200, 'session auth + status=done&since=: 200');
    const ids = data.rows.map(r => r.id);
    assert(!ids.includes('t1-old-done-recently-edited'), 'session auth: old-done-but-recently-edited task still excluded');
    assert(ids.includes('t2-recently-done'), 'session auth: recently-done task still included');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
