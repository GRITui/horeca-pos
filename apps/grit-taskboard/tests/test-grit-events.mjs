// Grit Taskboard — cross-app event intake (lib/gritEvents.js + api/grit-events.js)
// against an in-memory fake sql, modeled on tests/test-stripe-webhook.mjs
// (sign/verify round-trip, tamper/staleness rejection) and
// tests/test-booking-confirm.mjs (factory handler + fake sql shape).
process.env.GRIT_EVENT_WEBHOOK_SECRET = 'test-grit-webhook-secret';

import { signGritWebhook, verifyGritWebhook, parseGritEvent } from '../lib/gritEvents.js';
import { createGritEventsHandler } from '../api/grit-events.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const SECRET = process.env.GRIT_EVENT_WEBHOOK_SECRET;

// ── sign/verify round-trip ──────────────────────────────────────────────
{
  const rawBody = JSON.stringify({ hello: 'world' });
  const headers = signGritWebhook(SECRET, 'inventory.threshold_breached', rawBody, 1_800_000_000);
  assert(headers['x-grit-event'] === 'inventory.threshold_breached', 'signGritWebhook sets x-grit-event');
  assert(headers['x-grit-timestamp'] === '1800000000', 'signGritWebhook sets x-grit-timestamp');
  assert(/^v1=[0-9a-f]{64}$/.test(headers['x-grit-signature']), 'signGritWebhook produces a v1=<hex64> signature');

  const ok = verifyGritWebhook({
    secret: SECRET, rawBody,
    signatureHeader: headers['x-grit-signature'],
    timestampHeader: headers['x-grit-timestamp'],
    nowSeconds: 1_800_000_010, // 10s later, within the 5-minute tolerance
  });
  assert(ok === true, 'a validly signed, fresh payload verifies');

  const wrongSecret = verifyGritWebhook({
    secret: 'wrong-secret', rawBody,
    signatureHeader: headers['x-grit-signature'],
    timestampHeader: headers['x-grit-timestamp'],
    nowSeconds: 1_800_000_010,
  });
  assert(wrongSecret === false, 'wrong secret fails verification (never throws)');
}

// ── tampered-body rejection ─────────────────────────────────────────────
{
  const rawBody = JSON.stringify({ amount: 100 });
  const headers = signGritWebhook(SECRET, 'pos.velocity_surge', rawBody, 1_800_000_000);
  const tampered = JSON.stringify({ amount: 999 });
  const ok = verifyGritWebhook({
    secret: SECRET, rawBody: tampered,
    signatureHeader: headers['x-grit-signature'],
    timestampHeader: headers['x-grit-timestamp'],
    nowSeconds: 1_800_000_010,
  });
  assert(ok === false, 'a tampered body fails verification against the original signature');
}

// ── stale-timestamp rejection ───────────────────────────────────────────
{
  const rawBody = JSON.stringify({ x: 1 });
  const headers = signGritWebhook(SECRET, 'pos.velocity_surge', rawBody, 1_800_000_000);
  const ok = verifyGritWebhook({
    secret: SECRET, rawBody,
    signatureHeader: headers['x-grit-signature'],
    timestampHeader: headers['x-grit-timestamp'],
    nowSeconds: 1_800_000_000 + 301, // just past the 5-minute (300s) tolerance
  });
  assert(ok === false, 'a signature older than the 5-minute tolerance is rejected');

  const malformedHeader = verifyGritWebhook({
    secret: SECRET, rawBody,
    signatureHeader: 'not-a-real-signature',
    timestampHeader: headers['x-grit-timestamp'],
    nowSeconds: 1_800_000_010,
  });
  assert(malformedHeader === false, 'a malformed signature header is rejected, not thrown');

  const missingHeaders = verifyGritWebhook({ secret: SECRET, rawBody, signatureHeader: null, timestampHeader: null });
  assert(missingHeaders === false, 'missing headers are rejected, not thrown');
}

// ── envelope validation ─────────────────────────────────────────────────
{
  const goodEnvelope = {
    event: 'inventory.threshold_breached',
    timestamp: '2026-07-18T09:00:00.000Z',
    event_id: 'evt-1',
    organization_id: 'org-1',
    data: {
      location_id: 'loc-1', sku: 'SKU-1', product_id: 'prod-1', product_name: 'Widget',
      quantity_available: 2, reorder_threshold: 10,
    },
  };
  assert(parseGritEvent(goodEnvelope) === goodEnvelope, 'a well-formed threshold_breached envelope parses');
  assert(parseGritEvent({ ...goodEnvelope, event: 'not.a.real.event' }) === null, 'an unrecognized event name is rejected');
  assert(parseGritEvent({ ...goodEnvelope, data: { location_id: 'loc-1' } }) === null, 'a threshold_breached envelope missing required data fields is rejected');
  assert(parseGritEvent(null) === null, 'a non-object value is rejected, not thrown');
  assert(parseGritEvent({ ...goodEnvelope, timestamp: 'not-a-date' }) === null, 'an unparsable timestamp is rejected');
}

// ── api/grit-events.js handler, against a fake sql ──────────────────────
let orgLinks, opsTasks;
function resetDb() {
  orgLinks = [{ user_cuid: 'owner-1', organization_id: 'org-linked' }];
  opsTasks = [];
}

function fakeSql(text, params) {
  const t = Array.isArray(text) ? text.join('?') : text;
  const p = Array.isArray(text) ? Array.from(arguments).slice(1) : params;

  if (t.includes('select user_cuid from grit_org_links where organization_id')) {
    const row = orgLinks.find(l => l.organization_id === p[0]);
    return Promise.resolve(row ? [{ user_cuid: row.user_cuid }] : []);
  }
  if (t.trim().startsWith('insert into ops_tasks')) {
    const [id, userCuid, locationId, title, description, priority, triggeredBy, sourceEventId] = p;
    if (opsTasks.some(r => r.source_event_id === sourceEventId)) return Promise.resolve([]); // on conflict do nothing
    const now = new Date().toISOString();
    const row = {
      id, user_cuid: userCuid, location_id: locationId, title, description,
      status: 'todo', priority, triggered_by: triggeredBy, assigned_shift: null,
      source_event_id: sourceEventId, created_at: now, updated_at: now, completed_at: null,
    };
    opsTasks.push(row);
    return Promise.resolve([{ id: row.id }]);
  }
  if (t.includes('select id from ops_tasks where source_event_id')) {
    const row = opsTasks.find(r => r.source_event_id === p[0]);
    return Promise.resolve(row ? [{ id: row.id }] : []);
  }
  throw new Error('unexpected query in fakeSql: ' + t);
}

const handler = createGritEventsHandler({ getSql: () => fakeSql });

async function post(envelope, { badSignature = false, badTimestamp = false } = {}) {
  const rawBody = JSON.stringify(envelope);
  const headers = signGritWebhook(SECRET, envelope.event, rawBody, badTimestamp ? 1_000_000 : Math.floor(Date.now() / 1000));
  const req = new Request('https://x/api/grit-events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-grit-signature': badSignature ? 'v1=' + '0'.repeat(64) : headers['x-grit-signature'],
      'x-grit-timestamp': headers['x-grit-timestamp'],
    },
    body: rawBody,
  });
  const res = await handler(req);
  return { status: res.status, data: await res.json() };
}

async function main() {
  const thresholdEnvelope = {
    event: 'inventory.threshold_breached',
    timestamp: new Date().toISOString(),
    event_id: 'evt-threshold-1',
    organization_id: 'org-linked',
    data: {
      location_id: 'loc-1', sku: 'SKU-42', product_id: 'prod-42', product_name: 'Espresso Beans 1kg',
      quantity_available: 3, reorder_threshold: 10, supplier_name: 'Bean Bros',
    },
  };

  // ── threshold_breached creates a card, idempotently ───────────────────
  resetDb();
  let r = await post(thresholdEnvelope);
  assert(r.status === 201 && r.data.created === true, 'threshold_breached creates a new card (201)');
  assert(opsTasks.length === 1, 'exactly one ops_tasks row created');
  assert(opsTasks[0].title === 'Restock SKU: SKU-42 from Bean Bros immediately', 'card title names the SKU and supplier');
  assert(opsTasks[0].priority === 'high' && opsTasks[0].triggered_by === 'system_inventory', 'card carries high priority and system_inventory triggered_by');
  assert(opsTasks[0].user_cuid === 'owner-1', "card is scoped to the linked org's account");

  r = await post(thresholdEnvelope); // exact same event_id replayed
  assert(r.status === 200 && r.data.created === false, 'replaying the same event_id is idempotent (200, not created)');
  assert(opsTasks.length === 1, 'no duplicate card was created on replay');
  assert(r.data.taskId === opsTasks[0].id, 'idempotent replay still returns the existing taskId');

  // ── missing supplier_name falls back to "preferred supplier" ──────────
  resetDb();
  const noSupplier = { ...thresholdEnvelope, event_id: 'evt-threshold-2', data: { ...thresholdEnvelope.data, supplier_name: undefined } };
  delete noSupplier.data.supplier_name;
  r = await post(noSupplier);
  assert(r.status === 201, 'threshold_breached without supplier_name still creates a card');
  assert(opsTasks[0].title === 'Restock SKU: SKU-42 from preferred supplier immediately', 'missing supplier_name falls back to "preferred supplier"');

  // ── velocity_surge creates the auxiliary-terminal card ─────────────────
  resetDb();
  const velocityEnvelope = {
    event: 'pos.velocity_surge',
    timestamp: new Date().toISOString(),
    event_id: 'evt-velocity-1',
    organization_id: 'org-linked',
    data: { location_id: 'loc-9', transactions_in_window: 40, window_minutes: 5, threshold: 25 },
  };
  r = await post(velocityEnvelope);
  assert(r.status === 201, 'pos.velocity_surge creates a card');
  assert(opsTasks[0].title === 'Open auxiliary billing terminal lines', 'velocity_surge card has the expected fixed title');
  assert(opsTasks[0].priority === 'high' && opsTasks[0].triggered_by === 'system_pos', 'velocity_surge card carries high priority and system_pos triggered_by');

  // ── unlinked org: 202-skip, no card created ─────────────────────────────
  resetDb();
  r = await post({ ...velocityEnvelope, event_id: 'evt-velocity-unlinked', organization_id: 'org-unknown' });
  assert(r.status === 202 && r.data.skipped === true && r.data.reason === 'unlinked_org', 'an unlinked organization_id is a 202 skip');
  assert(opsTasks.length === 0, 'no card created for an unlinked org');

  // ── unknown/irrelevant event name: 202 ignore ───────────────────────────
  resetDb();
  r = await post({
    event: 'transaction.completed',
    timestamp: new Date().toISOString(),
    event_id: 'evt-txn-1',
    organization_id: 'org-linked',
    data: { transaction_id: 't1', location_id: 'loc-1', total_amount: 10, tax_amount: 1, items: [] },
  });
  assert(r.status === 202 && r.data.ignored === true, 'an event this app does not consume is 202-ignored');
  assert(opsTasks.length === 0, 'no card created for an ignored event');

  // ── bad signature -> 401 ────────────────────────────────────────────────
  resetDb();
  r = await post(thresholdEnvelope, { badSignature: true });
  assert(r.status === 401, 'a bad signature is rejected with 401');
  assert(opsTasks.length === 0, 'no card created on a rejected signature');

  // ── stale timestamp -> 401 ──────────────────────────────────────────────
  resetDb();
  r = await post(thresholdEnvelope, { badTimestamp: true });
  assert(r.status === 401, 'a stale timestamp is rejected with 401 (same signature-verification path)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
