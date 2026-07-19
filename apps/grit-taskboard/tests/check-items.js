/* Acceptance suite for "Pass M3-L2": products/extra services attach to a
 * pipeline ENGAGEMENT while the deal is still forming (the job edit modal's
 * new Items section), then flow automatically into the quote and the
 * invoice as linked line items — so stock decrement and totals work
 * end-to-end without retyping. Builds on Pass M3-L1's unified catalog
 * (tests/check-catalog.js). Harness pattern copied from that file.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-items.js
 * Expects http://localhost:8983 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8983';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'items' + Date.now());
  await page.fill('#auth-name', 'Items Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // EN so string assertions can compare against the EN dict.
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);
  // Skip the per-stage appointment gate — irrelevant to this suite, and
  // would otherwise pop a modal after every pipelineAction() advance below.
  await page.evaluate(async () => { settings.stageGateOff = true; await saveSetting('stageGateOff', true); });

  // In-page factories — window props die on page.reload() (never used in
  // this suite), installed once per the harness convention.
  await page.evaluate(() => {
    window.__mkProduct = async function (over) {
      const uid = currentUser.id;
      const obj = Object.assign({
        uid, name: 'Protein Pack', rate: 150, unit: 'pack', usageQty: 1,
        kind: 'product', sku: 'PRO-1', stockQty: 5, cost: 60,
        cuid: cuid(), updatedAt: nowISO(),
      }, over || {});
      const id = await dbAdd('services', obj);
      await reload();
      return id;
    };
    window.__mkService = async function (over) {
      const uid = currentUser.id;
      const obj = Object.assign({
        uid, name: 'Nutrition Consult', rate: 300, unit: 'session', usageQty: 1,
        cuid: cuid(), updatedAt: nowISO(),
      }, over || {});
      const id = await dbAdd('services', obj);
      await reload();
      return id;
    };
    window.__mkClient = async function (over) {
      const obj = Object.assign({
        uid: currentUser.id, name: 'Items Client', phone: '', notes: '',
        createdAt: nowISO(), cuid: cuid(),
      }, over || {});
      const id = await dbAdd('clients', obj);
      await reload();
      return id;
    };
    window.__mkJob = async function (stage, extra) {
      const uid = currentUser.id;
      const j = Object.assign({
        uid, date: todayISO(), client: 'Items Client', clientId: window.__cid, serviceId: null,
        serviceName: 'Personal Training', jobType: settings.workType || '', amount: 2000, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 2000, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO(),
      }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  const mkProduct = (over) => page.evaluate(o => window.__mkProduct(o), over || null);
  const mkService = (over) => page.evaluate(o => window.__mkService(o), over || null);
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);
  const job = (id, expr) => page.evaluate(args => {
    const j = jobs.find(x => x.id === args[0]);
    return eval(args[1]);
  }, [id, expr]);
  const svcRow = (id, expr) => page.evaluate(async args => {
    const s = await dbGet('services', args[0]);
    return eval(args[1]);
  }, [id, expr]);
  const invRow = (id, expr) => page.evaluate(async args => {
    const inv = await dbGet('invoices', args[0]);
    return eval(args[1]);
  }, [id, expr]);
  const openInvoice = async (id) => {
    await page.evaluate(() => switchScreen('invoices'));
    await page.waitForTimeout(200);
    await page.evaluate(invId => document.querySelector(`[data-inv="${invId}"]`)?.click(), id);
    await page.waitForSelector('#inv-detail-modal.open', { timeout: 5000 });
  };
  const waitStamped = (invId) => page.waitForFunction(async id => {
    const inv = await dbGet('invoices', id);
    return !!(inv && inv.stockDecrementedAt);
  }, invId, { timeout: 5000 }).catch(() => {});

  const cid = await page.evaluate(() => window.__mkClient()).then(id => { return id; });
  await page.evaluate(id => { window.__cid = id; }, cid);

  const proteinId = await mkProduct();
  const consultId = await mkService();

  // ═══ 1. Add items via the real Items UI on the job edit modal, then save ═
  const jobA = await mkJob('pitch', { client: 'Items Client A' });
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  assert(await page.locator('#job-items-body').count() === 1, '1: items section present in edit modal');
  assert((await page.locator('#job-items-body .pkg-status').textContent()).length > 0, '1: empty state shown with no items');

  await page.selectOption('#job-item-svc', String(proteinId));
  await page.fill('#job-item-qty', '2');
  await page.click('#job-items-body button[onclick*="addJobItem"]');
  await page.waitForTimeout(200);
  await page.selectOption('#job-item-svc', String(consultId));
  // qty input resets to its default (1) on re-render — leave as-is.
  await page.click('#job-items-body button[onclick*="addJobItem"]');
  await page.waitForTimeout(200);

  const itemRows = await page.locator('#job-items-body .list-row').count();
  assert(itemRows === 2, '1: two item rows rendered, got ' + itemRows);
  const itemsHtml = await page.evaluate(() => document.getElementById('job-items-body').innerHTML);
  assert(itemsHtml.includes('Protein Pack') && itemsHtml.includes('2 ×') && itemsHtml.includes('฿300'),
    '1: product row shows name + "2 ×" + line total ฿300, got snippet: ' + itemsHtml.slice(0, 300));
  assert(itemsHtml.includes('Nutrition Consult') && itemsHtml.includes('1 ×') && itemsHtml.includes('฿300'),
    '1: service row shows name + "1 ×" + line total ฿300');

  await page.evaluate(() => saveJob());
  await page.waitForTimeout(400);
  assert(await job(jobA, '(j.items||[]).length') === 2, '1: job.items length === 2 after save, got ' + await job(jobA, '(j.items||[]).length'));
  const item0 = await job(jobA, 'JSON.stringify(j.items[0])').then(JSON.parse);
  assert(item0.serviceId === proteinId && item0.name === 'Protein Pack' && item0.qty === 2 && item0.unitPrice === 150,
    '1: item[0] snapshot matches the product, got ' + JSON.stringify(item0));
  const item1 = await job(jobA, 'JSON.stringify(j.items[1])').then(JSON.parse);
  assert(item1.serviceId === consultId && item1.name === 'Nutrition Consult' && item1.qty === 1 && item1.unitPrice === 300,
    '1: item[1] snapshot matches the service, got ' + JSON.stringify(item1));
  assert(!!item0.id && !!item1.id, '1: each item carries its own cuid-style id');

  // ═══ 2. Catalog-edit isolation: a later price edit never rewrites history ═
  await page.evaluate(async id => {
    const s = await dbGet('services', id);
    s.rate = 999;
    await dbPut('services', s);
    await reload();
  }, proteinId);
  const catalogRateNow = await svcRow(proteinId, 's.rate');
  assert(catalogRateNow === 999, '2: catalog price actually changed to 999');
  assert(await job(jobA, 'j.items[0].unitPrice') === 150, '2: job.items snapshot unchanged (still 150) despite the catalog edit');

  // ═══ 3. Pipeline card chip shows item count + summed amount ═════════════
  // Card identity via the onclick's openEditJob(id) call — j.client itself
  // is always re-derived from the linked customer record by saveJob() (see
  // that function's own comment), so it can't be used to distinguish jobs.
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage(jobStage(jobs.find(x => x.id === id))); }, jobA);
  await page.waitForTimeout(300);
  const cardText = await page.locator(`.kb-card[onclick*="openEditJob(${jobA})"]`).textContent();
  assert(cardText.includes('🛒'), '3: card shows the 🛒 items chip, got: ' + cardText.slice(0, 160));
  assert(cardText.includes('2 item(s)'), '3: card chip shows "2 item(s)", got: ' + cardText.slice(0, 160));
  assert(cardText.includes('฿600'), '3: card chip shows the summed amount ฿600 (300+300), got: ' + cardText.slice(0, 160));

  // ═══ 4. Detail re-edit: remove one item, save → items length 1 ══════════
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  await page.locator('#job-items-body .list-row').nth(0).locator('button[aria-label="Remove item"]').click();
  await page.waitForTimeout(200);
  await page.evaluate(() => saveJob());
  await page.waitForTimeout(400);
  assert(await job(jobA, '(j.items||[]).length') === 1, '4: one item removed + saved → length 1');
  assert(await job(jobA, 'j.items[0].name') === 'Nutrition Consult', '4: the remaining item is the one NOT removed');

  // ═══ 5. A plain detail save (no items touch) preserves items (wipe-guard) ═
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  await page.fill('#j-notes', 'touched, but items untouched');
  await page.evaluate(() => saveJob());
  await page.waitForTimeout(400);
  assert(await job(jobA, '(j.items||[]).length') === 1, '5: an ordinary detail save (amount/notes only) still preserves items');
  assert(await job(jobA, 'j.notes') === 'touched, but items untouched', '5: the edit itself actually saved');

  // ═══ 6. Quote prefill: job at quote stage → pipelineAction → docgen form ═
  const jobB = await mkJob('quote', {
    client: 'Items Client B', serviceName: 'Personal Training', amount: 2000,
    items: [{ id: 'itm-b1', serviceId: proteinId, name: 'Protein Pack', qty: 3, unitPrice: 150 }],
  });
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage('quote'); }, jobB);
  await page.waitForTimeout(300);
  await page.evaluate(id => pipelineAction(id), jobB);
  await page.waitForSelector('#dg-modal.open', { timeout: 5000 });
  const dgItems = await page.evaluate(() => dgQuoteItems);
  assert(dgItems.length === 2, '6: quote form carries 2 lines (base service + engagement item), got ' + dgItems.length);
  const dgItemLine = dgItems.find(li => li.description === 'Protein Pack');
  assert(!!dgItemLine && dgItemLine.qty === 3 && dgItemLine.unitPrice === 150,
    '6: quote line for the item has correct qty/price, got ' + JSON.stringify(dgItemLine));
  const dgHtml = await page.evaluate(() => document.getElementById('dg-q-items-wrap').innerHTML);
  assert(dgHtml.includes('Protein Pack'), '6: the item name appears in the docgen form DOM');
  await page.click('#dg-modal button[onclick="closeDgModal()"]');
  await page.waitForTimeout(200);

  // ═══ 7. Invoice prefill from a bare job (skip quote): serviceId stamped ═
  const jobC = await mkJob('invoice', {
    client: 'Items Client C', serviceName: 'Personal Training', amount: 2000,
    items: [{ id: 'itm-c1', serviceId: proteinId, name: 'Protein Pack', qty: 2, unitPrice: 150 }],
  });
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage('invoice'); }, jobC);
  await page.waitForTimeout(300);
  await page.evaluate(id => pipelineAction(id), jobC);
  await page.waitForSelector('#inv-form-modal.open', { timeout: 5000 });
  const invLinesHtml = await page.evaluate(() => document.getElementById('inv-lines').innerHTML);
  assert(invLinesHtml.includes('Protein Pack'), '7: the item name appears in the invoice form DOM');
  const svcLineEl = await page.evaluate(id => !!document.querySelector(`.inv-line[data-service-id="${id}"]`), proteinId);
  assert(svcLineEl, '7: the item line row carries data-service-id for the product');
  await page.click('#inv-save');
  await page.waitForTimeout(500);
  const invIdC = await job(jobC, 'j.invoiceId');
  assert(invIdC != null, '7: saving the invoice linked it back onto the job (invoiceId set)');
  const savedItemLine = await invRow(invIdC, "JSON.stringify(inv.lineItems.find(li => li.description === 'Protein Pack'))").then(JSON.parse);
  assert(savedItemLine && savedItemLine.serviceId === proteinId && savedItemLine.qty === 2,
    '7: saved invoice lineItems entry has serviceId stamped + correct qty, got ' + JSON.stringify(savedItemLine));

  // ═══ 8. End-to-end stock: paying that invoice deducts stock exactly once ═
  await openInvoice(invIdC);
  await page.selectOption('#inv-d-status', 'paid');
  await waitStamped(invIdC);
  const afterPaid = await svcRow(proteinId, 's.stockQty');
  assert(afterPaid === 3, '8: stockQty 5 -> 3 after paying an invoice carrying the item at qty 2, got ' + afterPaid);

  await page.selectOption('#inv-d-status', 'sent');
  await page.waitForTimeout(300);
  await page.selectOption('#inv-d-status', 'paid');
  await page.waitForTimeout(600);
  const afterReflip = await svcRow(proteinId, 's.stockQty');
  assert(afterReflip === 3, '8: stockQty stays at 3 after paid -> sent -> paid (idempotent decrement), got ' + afterReflip);
  await page.click('#inv-d-close');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
