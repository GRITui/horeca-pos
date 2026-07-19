// Sidekick — Pass M3-L3's public storefront API: api/shop-public.js (public
// catalog read + order write) and api/order-requests.js (the freelancer's
// confirm/decline side). Against in-memory fake sql, same style as
// tests/test-invoice-public.mjs / tests/test-booking-confirm.mjs. Proves
// the GET catalog whitelist (kind='product', in-stock/untracked only), the
// POST server-side repricing + validation ladder, and the order-requests
// atomic confirm/decline state machine.
process.env.SESSION_SECRET = 'test-session-secret';

import { signSession } from '../lib/auth.js';
import { createShopPublicHandler } from '../api/shop-public.js';
import { createOrderRequestsHandler } from '../api/order-requests.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── In-memory tables ────────────────────────────────────────────────────
let users, services, orderRequests, teamMembers, nextOrderId;
function resetDb() {
  users = [{ cuid: 'owner-1', first_name: 'Somchai', username: 'somchai123', plan: 'pro', subscription_status: 'active', trial_ends_at: null }];
  services = [
    { cuid: 'svc-product-1', user_cuid: 'owner-1', name: 'Protein Pack', rate: 150, unit: 'pack', kind: 'product', sku: 'PRO-1', stock_qty: 5 },
    { cuid: 'svc-product-2', user_cuid: 'owner-1', name: 'Shaker', rate: 80, unit: 'ea', kind: 'product', sku: 'SHK-1', stock_qty: null },
    { cuid: 'svc-product-out', user_cuid: 'owner-1', name: 'Sold Out Bundle', rate: 500, unit: 'bundle', kind: 'product', sku: 'OUT-1', stock_qty: 0 },
    { cuid: 'svc-service-1', user_cuid: 'owner-1', name: 'Nutrition Consult', rate: 300, unit: 'session', kind: null, sku: null, stock_qty: null },
    { cuid: 'svc-other-user', user_cuid: 'owner-2', name: 'Someone Else Product', rate: 999, unit: 'ea', kind: 'product', sku: null, stock_qty: null },
  ];
  orderRequests = [];
  teamMembers = [];
  nextOrderId = 1;
}
resetDb();

// Fake sql supporting the exact queries both handlers run (function-call style).
function fakeSql(text, params) {
  const t = text;
  const p = params || [];

  if (t.includes('from team_members where member_cuid')) {
    const row = teamMembers.find(m => m.member_cuid === p[0]);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid }] : []);
  }
  if (t.includes('coalesce(first_name, username) as owner_name')) {
    const u = users.find(x => x.cuid === p[0]);
    return Promise.resolve(u ? [{ owner_name: u.first_name || u.username }] : []);
  }
  if (t.includes('select plan, subscription_status, trial_ends_at from users')) {
    return Promise.resolve(users.filter(u => u.cuid === p[0]));
  }
  if (t.includes('select cuid, name, unit, rate, sku, stock_qty from services')) {
    // GET catalog: kind='product' AND (stock_qty is null or stock_qty > 0)
    const rows = services
      .filter(s => s.user_cuid === p[0] && (s.kind || 'service') === 'product' && (s.stock_qty == null || s.stock_qty > 0))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Promise.resolve(rows);
  }
  if (t.includes('select cuid, name, rate from services')) {
    // POST repricing lookup: every product for this user, regardless of stock.
    const rows = services.filter(s => s.user_cuid === p[0] && (s.kind || 'service') === 'product');
    return Promise.resolve(rows);
  }
  if (t.startsWith('insert into order_requests')) {
    const [userCuid, clientName, contact, items, total] = p;
    orderRequests.push({
      id: nextOrderId++, user_cuid: userCuid, client_name: clientName, contact,
      items, total, status: 'requested', created_at: new Date().toISOString(),
    });
    return Promise.resolve([]);
  }
  if (t.includes('select id, client_name, contact, items, total, created_at') && t.includes("status = 'requested'") && t.trim().startsWith('select')) {
    const rows = orderRequests
      .filter(o => o.user_cuid === p[0] && o.status === 'requested')
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Promise.resolve(rows);
  }
  if (t.startsWith('update order_requests set status')) {
    const [status, id, userCuid] = p;
    const o = orderRequests.find(x => x.id === id && x.user_cuid === userCuid && x.status === 'requested');
    if (!o) return Promise.resolve([]);
    o.status = status;
    return Promise.resolve([{ id: o.id, client_name: o.client_name, contact: o.contact, items: o.items, total: o.total, created_at: o.created_at }]);
  }
  throw new Error('unexpected query in fakeSql: ' + t);
}

const shopHandler = createShopPublicHandler({ getSql: () => fakeSql });
const ordersHandler = createOrderRequestsHandler({ getSql: () => fakeSql });

async function callShop(method, { query = '', body, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (ip) headers['x-forwarded-for'] = ip;
  const res = await shopHandler(new Request('https://x/api/shop-public' + query, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, text, data: text ? JSON.parse(text) : null };
}
async function callOrders(method, body, token) {
  const res = await ordersHandler(new Request('https://x/api/order-requests', {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, data: await res.json() };
}

async function main() {
  const token = await signSession({ userCuid: 'owner-1' }, process.env.SESSION_SECRET);

  // ── GET catalog: only in-stock/untracked PRODUCT rows, right owner ────
  resetDb();
  let r = await callShop('GET', { query: '?u=owner-1' });
  assert(r.status === 200, 'GET catalog → 200, got ' + r.status);
  assert(r.data.ownerName === 'Somchai', 'ownerName resolves to owner first_name, got ' + r.data.ownerName);
  const names = r.data.products.map(p => p.name).sort();
  assert(names.length === 2 && names.includes('Protein Pack') && names.includes('Shaker'),
    'GET returns only the two in-stock/untracked products, got ' + JSON.stringify(names));
  assert(!names.includes('Sold Out Bundle'), 'a zero-stock product is excluded');
  assert(!names.includes('Nutrition Consult'), 'a plain service (kind !== product) is excluded');
  const proteinRow = r.data.products.find(p => p.name === 'Protein Pack');
  assert(proteinRow && proteinRow.sku === 'PRO-1' && proteinRow.stockQty === 5 && proteinRow.rate === 150,
    'product row carries cuid/name/unit/rate/sku/stockQty, got ' + JSON.stringify(proteinRow));

  // ── GET unknown user → 404, generic, never leaks a connection string ──
  r = await callShop('GET', { query: '?u=does-not-exist', ip: '1.1.1.1' });
  assert(r.status === 404, 'GET unknown user → 404, got ' + r.status);
  assert(!r.text.includes('postgres://'), 'GET 404 body never leaks a connection string');

  // ── POST reprices server-side: client-sent price is ignored ───────────
  resetDb();
  r = await callShop('POST', {
    body: { u: 'owner-1', name: 'Client A', contact: 'line:abc', items: [{ cuid: 'svc-product-1', qty: 2, unitPrice: 1 }] },
    ip: '2.2.2.1',
  });
  assert(r.status === 200 && r.data.ok === true, 'POST happy path → 200 ok, got ' + r.status + ' ' + r.text);
  assert(!('name' in r.data) && !('contact' in r.data), 'POST response never echoes name/contact back');
  assert(orderRequests.length === 1, 'exactly one order_requests row inserted');
  const stored = orderRequests[0];
  assert(stored.items[0].unit_price === 150, 'stored unit_price comes from the catalog (150), not the client-sent 1, got ' + stored.items[0].unit_price);
  assert(stored.total === 300, 'stored total is qty × catalog price (2×150=300), got ' + stored.total);
  assert(stored.client_name === 'Client A' && stored.contact === 'line:abc', 'client_name/contact stored as submitted');

  // ── POST rejects a foreign/unknown cuid — whole request 400 ───────────
  resetDb();
  r = await callShop('POST', {
    body: { u: 'owner-1', name: 'Client B', items: [{ cuid: 'svc-other-user', qty: 1 }] },
    ip: '2.2.2.2',
  });
  assert(r.status === 400, "POST with another user's product cuid → 400, got " + r.status);
  r = await callShop('POST', {
    body: { u: 'owner-1', name: 'Client B', items: [{ cuid: 'does-not-exist-cuid', qty: 1 }] },
    ip: '2.2.2.3',
  });
  assert(r.status === 400, 'POST with an unknown cuid → 400, got ' + r.status);
  assert(orderRequests.length === 0, 'no order_requests row inserted when any cuid is invalid');

  // ── POST rejects bad quantities ────────────────────────────────────────
  r = await callShop('POST', { body: { u: 'owner-1', name: 'C', items: [{ cuid: 'svc-product-1', qty: 0 }] }, ip: '2.2.2.4' });
  assert(r.status === 400, 'qty 0 → 400, got ' + r.status);
  r = await callShop('POST', { body: { u: 'owner-1', name: 'C', items: [{ cuid: 'svc-product-1', qty: 1000 }] }, ip: '2.2.2.5' });
  assert(r.status === 400, 'qty 1000 → 400, got ' + r.status);
  r = await callShop('POST', { body: { u: 'owner-1', name: 'C', items: [{ cuid: 'svc-product-1', qty: 1.5 }] }, ip: '2.2.2.6' });
  assert(r.status === 400, 'non-integer qty → 400, got ' + r.status);

  // ── POST rejects more than 20 items ────────────────────────────────────
  const tooManyItems = Array.from({ length: 21 }, () => ({ cuid: 'svc-product-1', qty: 1 }));
  r = await callShop('POST', { body: { u: 'owner-1', name: 'C', items: tooManyItems }, ip: '2.2.2.7' });
  assert(r.status === 400, '21 items → 400, got ' + r.status);

  // ── order-requests: GET lists only this owner's 'requested' rows ──────
  resetDb();
  orderRequests = [
    { id: 1, user_cuid: 'owner-1', client_name: 'A', contact: null, items: [{ service_cuid: 'svc-product-1', name: 'Protein Pack', qty: 2, unit_price: 150 }], total: 300, status: 'requested', created_at: '2026-07-16T01:00:00Z' },
    { id: 2, user_cuid: 'owner-1', client_name: 'B', contact: 'line:b', items: [], total: 0, status: 'confirmed', created_at: '2026-07-16T02:00:00Z' },
    { id: 3, user_cuid: 'owner-2', client_name: 'C', contact: null, items: [], total: 0, status: 'requested', created_at: '2026-07-16T03:00:00Z' },
  ];
  nextOrderId = 4;
  r = await callOrders('GET', null, token);
  assert(r.status === 200 && r.data.rows.length === 1 && r.data.rows[0].id === 1,
    "GET lists only owner-1's 'requested' rows, got " + JSON.stringify(r.data.rows.map(x => x.id)));
  assert(r.data.rows[0].clientName === 'A' && r.data.rows[0].total === 300, 'GET row carries the contract fields');

  // ── Confirm flips atomically; a second confirm on the same id → 409 ───
  r = await callOrders('POST', { id: 1, action: 'confirm' }, token);
  assert(r.status === 200 && r.data.status === 'confirmed', 'first confirm succeeds, got ' + r.status + ' ' + JSON.stringify(r.data));
  assert(orderRequests.find(o => o.id === 1).status === 'confirmed', 'row flips requested → confirmed');
  r = await callOrders('POST', { id: 1, action: 'confirm' }, token);
  assert(r.status === 409, 'second confirm on the same (already-resolved) id → 409, got ' + r.status);

  // ── Decline path ────────────────────────────────────────────────────────
  resetDb();
  orderRequests = [{ id: 5, user_cuid: 'owner-1', client_name: 'D', contact: null, items: [], total: 0, status: 'requested', created_at: '2026-07-16T04:00:00Z' }];
  r = await callOrders('POST', { id: 5, action: 'decline' }, token);
  assert(r.status === 200 && r.data.status === 'declined' && orderRequests[0].status === 'declined',
    'decline flips requested → declined, got ' + r.status + ' ' + JSON.stringify(r.data));

  // ── Never leaks a connection string on any response body ──────────────
  const bodies = [JSON.stringify(r.data)];
  assert(!bodies.some(b => b.includes('postgres://')), 'no response body ever contains a connection string');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
