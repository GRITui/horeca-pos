// Sidekick — T-24h LINE booking reminders (api/cron-reminders.js) against an
// in-memory fake sql + a globalThis.fetch stub for the LINE token-exchange
// call (getLineAccessToken, lib/line.js) — same harness style as
// tests/test-booking-confirm.mjs (fake sql keyed on query text) and
// tests/test-migrate.mjs (token-gating checks). `push` is injected directly
// (createCronRemindersHandler's factory seam) so the actual LINE push call
// never needs a real network stub — only the token exchange does.
process.env.CRON_SECRET = 'test-cron-secret';

import { createCronRemindersHandler } from '../api/cron-reminders.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// LINE token-exchange stub — the only real network call left un-injected
// (getLineAccessToken lives in lib/line.js, imported directly, not through
// the factory). Any other URL hitting fetch would mean push wasn't actually
// injected, so it throws loudly instead of silently succeeding.
globalThis.fetch = async (url) => {
  if (url === 'https://api.line.me/v2/oauth/accessToken') {
    return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// ── In-memory "bookings" table + the due-window query's filtering logic ──
let bookings, channels, users, updateCalls, dueQueryText;
function resetDb() {
  bookings = [];
  channels = [];
  users = [{ cuid: 'owner-1', first_name: 'Nam', username: 'namu' }];
  updateCalls = [];
  dueQueryText = null;
}

function fakeSql(text, params) {
  const t = text;
  const p = params || [];

  if (t.includes('from bookings b') && t.includes('join availability_slots')) {
    dueQueryText = t; // captured so the query-shape assertions below can inspect it
    const now = Date.now();
    const windowEnd = now + 24 * 3600 * 1000;
    const due = bookings.filter(b =>
      b.status === 'confirmed' &&
      b.client_line_user_id != null &&
      b.reminder_sent_at == null &&
      new Date(b.starts_at).getTime() > now &&
      new Date(b.starts_at).getTime() <= windowEnd
    );
    return Promise.resolve(due.map(b => ({
      id: b.id, user_cuid: b.user_cuid, client_name: b.client_name,
      client_line_user_id: b.client_line_user_id, starts_at: b.starts_at, ends_at: b.ends_at,
      service_name: b.service_name || null,
    })));
  }

  if (t.includes('from line_channels')) {
    return Promise.resolve(channels.filter(c => c.user_cuid === p[0]));
  }

  if (t.includes('from users where cuid')) {
    return Promise.resolve(users.filter(u => u.cuid === p[0]));
  }

  if (t.includes('reminder_sent_at = now()')) {
    updateCalls.push(p[0]);
    const b = bookings.find(x => x.id === p[0]);
    if (b) b.reminder_sent_at = new Date().toISOString();
    return Promise.resolve([]);
  }

  throw new Error('unexpected query in fakeSql: ' + t);
}

function makeHandler(push) {
  return createCronRemindersHandler({ getSql: () => fakeSql, push });
}

function call(handler, token) {
  return handler(new Request('https://x/api/cron-reminders', {
    method: 'GET',
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
  }));
}

async function main() {
  const noopPush = async () => true;
  const handler = makeHandler(noopPush);

  // ── Auth gating ──────────────────────────────────────────────────────
  resetDb();
  {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const res = await call(handler, 'anything');
    assert(res.status === 404, 'unset CRON_SECRET disables the endpoint entirely (404)');
    process.env.CRON_SECRET = saved;
  }
  {
    const res = await call(handler, 'wrong-secret');
    assert(res.status === 403, 'wrong bearer token → 403');
  }
  {
    const res = await call(handler, undefined);
    assert(res.status === 403, 'missing bearer token → 403');
  }
  {
    const res = await call(handler, 'test-cron-secret');
    const data = await res.json();
    assert(res.status === 200 && data.ok === true, 'correct bearer proceeds past the gate');
    assert(data.due === 0 && data.sent === 0 && data.failed === 0, 'empty DB → all-zero counts');
  }

  // ── Due-window query shape ───────────────────────────────────────────
  resetDb();
  bookings.push({
    id: 1, user_cuid: 'owner-1', client_name: 'Client A', client_line_user_id: 'Uclient-a',
    status: 'confirmed', reminder_sent_at: null, starts_at: hoursFromNow(2), ends_at: hoursFromNow(3),
    service_name: 'Massage',
  });
  channels.push({ user_cuid: 'owner-1', channel_id: 'test-channel-id', channel_secret: 'shh' });
  {
    const res = await call(handler, 'test-cron-secret');
    const data = await res.json();
    assert(data.due === 1, 'a confirmed, un-reminded LINE booking inside the 24h window is selected');
    assert(dueQueryText && dueQueryText.includes("b.status = 'confirmed'"), 'due query filters on status = confirmed');
    assert(dueQueryText && dueQueryText.includes('b.reminder_sent_at is null'), 'due query filters on reminder_sent_at is null');
    assert(dueQueryText && dueQueryText.includes('s.starts_at > now()'), 'due query has the lower starts_at bound (never remind about the past)');
    assert(dueQueryText && dueQueryText.includes("s.starts_at <= now() + interval '24 hours'"), 'due query has the 24h upper starts_at bound');
  }

  // ── Successful push stamps the booking, response counts reflect it ───
  resetDb();
  bookings.push({
    id: 2, user_cuid: 'owner-1', client_name: 'Client B', client_line_user_id: 'Uclient-b',
    status: 'confirmed', reminder_sent_at: null, starts_at: hoursFromNow(5), ends_at: hoursFromNow(6),
    service_name: 'Consult',
  });
  channels.push({ user_cuid: 'owner-1', channel_id: 'test-channel-id', channel_secret: 'shh' });
  {
    const okHandler = makeHandler(async () => true);
    const res = await call(okHandler, 'test-cron-secret');
    const data = await res.json();
    assert(updateCalls.includes(2), 'successful push fires the reminder_sent_at stamp for that booking id');
    assert(data.due === 1 && data.sent === 1 && data.failed === 0, 'response counts: due:1 sent:1 failed:0');
    assert(bookings[0].reminder_sent_at !== null, 'the in-memory booking row itself is now stamped');
  }

  // ── Failed push (e.g. LINE API 500) leaves the row unstamped ─────────
  resetDb();
  bookings.push({
    id: 3, user_cuid: 'owner-1', client_name: 'Client C', client_line_user_id: 'Uclient-c',
    status: 'confirmed', reminder_sent_at: null, starts_at: hoursFromNow(10), ends_at: hoursFromNow(11),
    service_name: null,
  });
  channels.push({ user_cuid: 'owner-1', channel_id: 'test-channel-id', channel_secret: 'shh' });
  {
    const failHandler = makeHandler(async () => false); // simulates linePush() returning false on a non-2xx
    const res = await call(failHandler, 'test-cron-secret');
    const data = await res.json();
    assert(updateCalls.length === 0, 'a failed push never fires the reminder_sent_at stamp');
    assert(data.due === 1 && data.sent === 0 && data.failed === 1, 'response counts: due:1 sent:0 failed:1');
    assert(bookings[0].reminder_sent_at === null, 'the in-memory booking row stays unstamped, eligible for the next hourly run');
  }

  // ── Missing LINE channel: row skipped, no stamp, no crash ────────────
  resetDb();
  bookings.push({
    id: 4, user_cuid: 'owner-no-channel', client_name: 'Client D', client_line_user_id: 'Uclient-d',
    status: 'confirmed', reminder_sent_at: null, starts_at: hoursFromNow(3), ends_at: hoursFromNow(4),
    service_name: 'Massage',
  });
  // deliberately no channels.push() for owner-no-channel
  {
    let threw = false;
    let res;
    try {
      res = await call(handler, 'test-cron-secret');
    } catch (err) { threw = true; }
    assert(!threw, 'a missing line_channels row for the account does not crash the handler');
    const data = await res.json();
    assert(data.due === 1 && data.sent === 0 && data.failed === 0, 'missing-channel row is skipped: due:1 but neither sent nor failed');
    assert(updateCalls.length === 0, 'missing-channel row is never stamped');
  }

  // ── Response body never leaks client identifiers or the DB connection string ──
  resetDb();
  bookings.push({
    id: 5, user_cuid: 'owner-1', client_name: 'Client E', client_line_user_id: 'Uclient-secret-id',
    status: 'confirmed', reminder_sent_at: null, starts_at: hoursFromNow(1), ends_at: hoursFromNow(2),
    service_name: 'Massage',
  });
  channels.push({ user_cuid: 'owner-1', channel_id: 'test-channel-id', channel_secret: 'shh' });
  {
    const okHandler = makeHandler(async () => true);
    const res = await call(okHandler, 'test-cron-secret');
    const bodyText = await res.text();
    assert(!bodyText.includes('Uclient-secret-id'), 'response body never contains a client_line_user_id value');
    assert(!bodyText.includes('postgres://'), 'response body never contains a connection-string shape');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
