// Sidekick — api/invoice-public.js: the M2b public invoice page's read/write
// API. Against an in-memory fake sql, same style as tests/test-booking-confirm.mjs.
// Proves the GET response is a strict whitelist (never the slips array/data
// URLs themselves — see the file's own header on why), and the POST slip-
// upload's validation ladder (bad cuid / bad dataUrl / oversize / full).
import { createInvoicePublicHandler } from '../api/invoice-public.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── In-memory tables ────────────────────────────────────────────────────
let invoices, users;
function resetDb() {
  users = [{ cuid: 'owner-1', first_name: 'Somchai', username: 'somchai123' }];
  invoices = [
    {
      cuid: 'inv-cuid-1', user_cuid: 'owner-1', number: 'INV-2026-001',
      issue_date: '2026-07-01', due_date: '2026-07-15', client_name: 'Test Client',
      line_items: [{ description: 'Design work', qty: 1, unitPrice: 1000 }],
      subtotal: 1000, vat_pct: 7, vat: 70, wht_pct: 3, wht: 30, client_pays: 1070,
      deposit_pct: 0, status: 'sent',
      payment_channels: [{ id: 'pp1', type: 'promptpay', label: 'PromptPay', detail: '0812345678' }],
      notes: 'Thanks for your business', slips: [], updated_at: '2026-07-01T00:00:00Z',
    },
    {
      cuid: 'inv-cuid-full', user_cuid: 'owner-1', number: 'INV-2026-002',
      issue_date: '2026-07-02', due_date: null, client_name: 'Full Client',
      line_items: [], subtotal: 500, vat_pct: 0, vat: 0, wht_pct: 0, wht: 0,
      client_pays: 500, deposit_pct: 0, status: 'sent', payment_channels: [], notes: '',
      slips: [0, 1, 2, 3, 4].map(i => ({ id: 's' + i, dataUrl: 'data:image/jpeg;base64,AAAA', at: '2026-07-02T00:00:00Z', source: 'client' })),
      updated_at: '2026-07-02T00:00:00Z',
    },
  ];
}
resetDb();

// Fake sql supporting the exact queries the handler runs (function-call style).
function fakeSql(text, params) {
  const t = text;
  const p = params || [];
  if (t.includes('from invoices inv') && t.includes('join users')) {
    const inv = invoices.find(i => i.cuid === p[0]);
    if (!inv) return Promise.resolve([]);
    const u = users.find(x => x.cuid === inv.user_cuid);
    return Promise.resolve([{ ...inv, owner_name: u ? (u.first_name || u.username) : null }]);
  }
  if (t.includes('select slips from invoices')) {
    const inv = invoices.find(i => i.cuid === p[0]);
    return Promise.resolve(inv ? [{ slips: inv.slips }] : []);
  }
  if (t.includes('update invoices set slips')) {
    const inv = invoices.find(i => i.cuid === p[1]);
    if (inv) inv.slips = p[0];
    return Promise.resolve([]);
  }
  throw new Error('unexpected query in fakeSql: ' + t);
}

const handler = createInvoicePublicHandler({ getSql: () => fakeSql });

async function call(method, { query = '', body, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (ip) headers['x-forwarded-for'] = ip;
  const res = await handler(new Request('https://x/api/invoice-public' + query, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, text, data: text ? JSON.parse(text) : null };
}

async function main() {
  // ── GET happy path: strict whitelist ─────────────────────────────────
  let r = await call('GET', { query: '?i=inv-cuid-1' });
  assert(r.status === 200, 'GET known cuid → 200, got ' + r.status);
  const expectedKeys = [
    'number', 'issueDate', 'dueDate', 'clientName', 'lineItems', 'subtotal',
    'vatPct', 'vat', 'whtPct', 'wht', 'clientPays', 'depositPct', 'status',
    'paymentChannels', 'notes', 'ownerName', 'slipCount',
  ].sort();
  assert(JSON.stringify(Object.keys(r.data).sort()) === JSON.stringify(expectedKeys),
    'GET response is exactly the whitelist, got keys: ' + Object.keys(r.data).sort().join(','));
  assert(!('slips' in r.data) && !('dataUrl' in r.data), 'GET response never carries raw slips/dataUrls');
  assert(r.data.ownerName === 'Somchai', 'ownerName resolves to the owner\'s first_name, got ' + r.data.ownerName);
  assert(r.data.number === 'INV-2026-001' && r.data.clientPays === 1070, 'GET returns the right invoice fields');
  assert(r.data.slipCount === 0, 'slipCount reflects the (empty) slips array length');

  // ── GET unknown cuid → 404, generic ──────────────────────────────────
  r = await call('GET', { query: '?i=does-not-exist', ip: '1.1.1.1' });
  assert(r.status === 404, 'GET unknown cuid → 404, got ' + r.status);
  assert(!r.text.includes('postgres://'), 'GET 404 body never leaks a connection string');

  // ── GET missing ?i= → 404 too (no distinguishing detail) ─────────────
  r = await call('GET', { ip: '1.1.1.2' });
  assert(r.status === 404, 'GET with no ?i= → 404, got ' + r.status);

  // ── POST happy path: appends a slip, returns slipCount ───────────────
  const goodDataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  r = await call('POST', { body: { i: 'inv-cuid-1', dataUrl: goodDataUrl }, ip: '2.2.2.1' });
  assert(r.status === 200 && r.data.ok === true, 'POST happy path → 200 ok, got ' + r.status + ' ' + r.text);
  assert(r.data.slipCount === 1, 'POST happy path returns slipCount 1, got ' + r.data.slipCount);
  const stored = invoices.find(i => i.cuid === 'inv-cuid-1').slips;
  assert(stored.length === 1 && stored[0].dataUrl === goodDataUrl && stored[0].source === 'client' && stored[0].id && stored[0].at,
    'appended slip carries id/dataUrl/at/source, got ' + JSON.stringify(stored));

  // ── POST bad dataUrl → 400 ───────────────────────────────────────────
  r = await call('POST', { body: { i: 'inv-cuid-1', dataUrl: 'not-a-data-url' }, ip: '2.2.2.2' });
  assert(r.status === 400, 'POST bad dataUrl → 400, got ' + r.status);

  // ── POST oversize dataUrl → 400 ──────────────────────────────────────
  const hugeDataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(2_000_001);
  r = await call('POST', { body: { i: 'inv-cuid-1', dataUrl: hugeDataUrl }, ip: '2.2.2.3' });
  assert(r.status === 400, 'POST oversize dataUrl → 400, got ' + r.status);

  // ── POST to an unknown invoice → 404 ─────────────────────────────────
  r = await call('POST', { body: { i: 'does-not-exist', dataUrl: goodDataUrl }, ip: '2.2.2.4' });
  assert(r.status === 404, 'POST unknown cuid → 404, got ' + r.status);

  // ── POST a 6th slip onto an already-full invoice → 409 slips_full ────
  r = await call('POST', { body: { i: 'inv-cuid-full', dataUrl: goodDataUrl }, ip: '2.2.2.5' });
  assert(r.status === 409 && r.data.code === 'slips_full', 'POST 6th slip → 409 slips_full, got ' + r.status + ' ' + r.text);
  assert(!r.text.includes('postgres://'), 'POST 409 body never leaks a connection string');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
