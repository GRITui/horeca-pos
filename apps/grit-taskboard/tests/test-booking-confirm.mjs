// Sidekick — booking confirm/decline state machine (api/booking-requests.js)
// against an in-memory fake sql, same style as test-teams.mjs. Exercises the
// atomic winner-takes-the-slot rule two racing 'requested' bookings hit.
process.env.SESSION_SECRET = 'test-session-secret';

import { signSession } from '../lib/auth.js';
import { createBookingRequestsHandler } from '../api/booking-requests.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── In-memory tables ────────────────────────────────────────────────────
let slots, bookings, users, teamMembers;
function resetDb() {
  slots = [
    { id: 1, user_cuid: 'owner-1', starts_at: '2026-08-01T10:00:00Z', ends_at: '2026-08-01T11:00:00Z', status: 'held', hold_expires_at: '2099-01-01T00:00:00Z' },
    { id: 2, user_cuid: 'owner-1', starts_at: '2026-08-02T10:00:00Z', ends_at: '2026-08-02T11:00:00Z', status: 'open', hold_expires_at: null },
  ];
  bookings = [
    { id: 11, user_cuid: 'owner-1', slot_id: 1, service_cuid: null, client_name: 'A', client_line_user_id: null, status: 'requested', created_at: '2026-07-16T01:00:00Z' },
    { id: 12, user_cuid: 'owner-1', slot_id: 1, service_cuid: null, client_name: 'B', client_line_user_id: null, status: 'requested', created_at: '2026-07-16T02:00:00Z' },
  ];
  users = [{ cuid: 'owner-1', plan: 'pro', subscription_status: 'active', trial_ends_at: null }];
  teamMembers = [];
}

// Fake sql supporting the exact queries the handler runs (function-call style).
function fakeSql(text, params) {
  const t = Array.isArray(text) ? text.join('?') : text;
  const p = Array.isArray(text) ? Array.from(arguments).slice(1) : params;
  if (t.includes('from team_members where member_cuid')) {
    const row = teamMembers.find(m => m.member_cuid === p[0]);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid }] : []);
  }
  if (t.includes('select plan, subscription_status, trial_ends_at from users')) {
    return Promise.resolve(users.filter(u => u.cuid === p[0]));
  }
  if (t.includes("b.status = 'requested'") && t.trim().startsWith('select b.id, b.slot_id, b.client_name')) {
    // GET list
    return Promise.resolve(bookings
      .filter(b => b.user_cuid === p[0] && b.status === 'requested')
      .map(b => {
        const s = slots.find(x => x.id === b.slot_id);
        return { id: b.id, slot_id: b.slot_id, client_name: b.client_name, created_at: b.created_at,
          starts_at: s.starts_at, ends_at: s.ends_at,
          hold_expired: s.status === 'open' || (s.status === 'held' && s.hold_expires_at < new Date().toISOString()),
          service_name: null };
      }));
  }
  if (t.includes('where b.id = $1 and b.user_cuid = $2')) {
    return Promise.resolve(bookings
      .filter(b => b.id === p[0] && b.user_cuid === p[1] && b.status === 'requested')
      .map(b => ({ id: b.id, slot_id: b.slot_id, client_line_user_id: b.client_line_user_id, client_name: b.client_name, service_name: null })));
  }
  if (t.includes("set status = 'booked'")) {
    const s = slots.find(x => x.id === p[0] && x.user_cuid === p[1] && (x.status === 'held' || x.status === 'open'));
    if (!s) return Promise.resolve([]);
    s.status = 'booked'; s.hold_expires_at = null;
    return Promise.resolve([{ id: s.id, starts_at: s.starts_at }]);
  }
  if (t.includes("set status = 'confirmed'")) {
    const b = bookings.find(x => x.id === p[0]); if (b) b.status = 'confirmed';
    return Promise.resolve([]);
  }
  if (t.includes("set status = 'declined'")) {
    const b = bookings.find(x => x.id === p[0]); if (b) b.status = 'declined';
    return Promise.resolve([]);
  }
  if (t.includes("set status = 'open'")) {
    const s = slots.find(x => x.id === p[0] && x.user_cuid === p[1] && x.status === 'held');
    if (s) { s.status = 'open'; s.hold_expires_at = null; }
    return Promise.resolve([]);
  }
  if (t.includes('from line_channels')) return Promise.resolve([]);
  throw new Error('unexpected query in fakeSql: ' + t);
}

const handler = createBookingRequestsHandler({ getSql: () => fakeSql });

async function call(method, body, token) {
  const req = new Request('https://x/api/booking-requests', {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req);
  return { status: res.status, data: await res.json() };
}

async function main() {
  const token = await signSession({ userCuid: 'owner-1' }, process.env.SESSION_SECRET);
  const staffToken = await signSession({ userCuid: 'staff-1' }, process.env.SESSION_SECRET);

  // ── GET shape ─────────────────────────────────────────────────────────
  resetDb();
  let r = await call('GET', null, token);
  assert(r.status === 200 && r.data.rows.length === 2, 'GET lists both pending requests');
  assert(r.data.rows[0].clientName && Number.isInteger(r.data.rows[0].slotId) && 'holdExpired' in r.data.rows[0], 'GET row carries the contract fields');

  // ── Confirm happy path ────────────────────────────────────────────────
  r = await call('POST', { bookingId: 11, action: 'confirm' }, token);
  assert(r.status === 200 && r.data.status === 'confirmed', 'confirm succeeds');
  assert(slots[0].status === 'booked' && slots[0].hold_expires_at === null, 'slot flips held → booked');
  assert(bookings[0].status === 'confirmed', 'booking flips requested → confirmed');

  // ── Race: second confirm on the same (now booked) slot ───────────────
  r = await call('POST', { bookingId: 12, action: 'confirm' }, token);
  assert(r.status === 409 && r.data.code === 'slot_taken', 'second confirm on a booked slot → 409 slot_taken');
  assert(bookings[1].status === 'requested', 'losing booking stays requested (can still be declined)');

  // ── Decline releases held, never un-books ────────────────────────────
  r = await call('POST', { bookingId: 12, action: 'decline' }, token);
  assert(r.status === 200 && bookings[1].status === 'declined', 'decline flips to declined');
  assert(slots[0].status === 'booked', "decline never releases a 'booked' slot (belongs to the winner)");

  resetDb();
  r = await call('POST', { bookingId: 11, action: 'decline' }, token);
  assert(slots[0].status === 'open' && slots[0].hold_expires_at === null, 'declining a held request releases the slot to open');

  // ── Confirm from an expired/open slot still works ─────────────────────
  resetDb();
  slots[0].status = 'open'; slots[0].hold_expires_at = null;   // hold lapsed, nobody re-grabbed
  r = await call('POST', { bookingId: 11, action: 'confirm' }, token);
  assert(r.status === 200 && slots[0].status === 'booked', 'confirm from a lapsed-open slot books it (client asked, freelancer said yes)');

  // ── Team member resolves to the owner ─────────────────────────────────
  resetDb();
  teamMembers = [{ org_owner_cuid: 'owner-1', member_cuid: 'staff-1' }];
  r = await call('GET', null, staffToken);
  assert(r.status === 200 && r.data.rows.length === 2, "staff sees the owner's pending requests (resolveDataOwner)");

  // ── Locked owner blocks writes ────────────────────────────────────────
  resetDb();
  users[0].subscription_status = 'canceled';
  r = await call('POST', { bookingId: 11, action: 'confirm' }, token);
  assert(r.status === 402 && r.data.code === 'locked', 'locked account gets 402 on confirm');
  assert(slots[0].status === 'held', 'locked confirm leaves the slot untouched');

  // ── Unknown booking / bad input ───────────────────────────────────────
  resetDb();
  r = await call('POST', { bookingId: 999, action: 'confirm' }, token);
  assert(r.status === 404, 'unknown booking → 404');
  r = await call('POST', { bookingId: 11, action: 'nonsense' }, token);
  assert(r.status === 400, 'bad action → 400');
  r = await call('GET', null, 'not-a-token');
  assert(r.status === 401, 'bad token → 401');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
