/* Acceptance suite for "Pass M3-L1": unifying the Services catalog into a
 * product/service catalog — kind toggle + sku/stock/cost fields on the
 * catalog record, the invoice line-item picker carrying a serviceId link,
 * and automatic stock decrement (with double-decrement protection) across
 * all three paid-transition paths. Harness pattern copied from
 * tests/check-payments.js / tests/check-ux-flow.js.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-catalog.js
 * Expects http://localhost:8973 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8973';
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
  await page.fill('#auth-user', 'catalog' + Date.now());
  await page.fill('#auth-name', 'Catalog Tester');
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

  // In-page factories — window props die on page.reload() (never used in
  // this suite), installed once per the harness convention.
  await page.evaluate(() => {
    window.__mkLegacyService = async function (over) {
      const uid = currentUser.id;
      // Deliberately NO `kind` field at all — simulates a pre-existing
      // record from before Pass M3-L1 (the "no migration" guarantee: a
      // missing kind must still render/behave as a plain service).
      const obj = Object.assign({
        uid, name: 'Legacy Consulting', rate: 500, unit: 'hour', usageQty: 1,
        cuid: cuid(), updatedAt: nowISO(),
      }, over || {});
      const id = await dbAdd('services', obj);
      await reload();
      return id;
    };
    window.__mkProduct = async function (over) {
      const uid = currentUser.id;
      const obj = Object.assign({
        uid, name: 'Detergent 1L', rate: 120, unit: 'piece', usageQty: 1,
        kind: 'product', sku: null, stockQty: null, cost: null,
        cuid: cuid(), updatedAt: nowISO(),
      }, over || {});
      const id = await dbAdd('services', obj);
      await reload();
      return id;
    };
    window.__mkInvoice = async function (over) {
      const uid = currentUser.id;
      const base = {
        uid, number: 'INV-' + Math.random().toString(36).slice(2, 8), issueDate: todayISO(), dueDate: '',
        clientId: null, clientName: 'Catalog Client', clientTaxId: '', clientAddress: '',
        lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], subtotal: 1000,
        whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1000, youReceive: 1000, depositPct: 0,
        status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(),
      };
      const id = await dbAdd('invoices', Object.assign(base, over || {}));
      await reload();
      return id;
    };
    window.__mkJob = async function (stage, extra) {
      const uid = currentUser.id;
      const j = Object.assign({
        uid, date: todayISO(), client: 'Catalog Client', clientId: null, serviceId: null,
        serviceName: 'Job', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO(),
      }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  const mkLegacyService = (over) => page.evaluate(o => window.__mkLegacyService(o), over || null);
  const mkProduct = (over) => page.evaluate(o => window.__mkProduct(o), over || null);
  const mkInvoice = (over) => page.evaluate(o => window.__mkInvoice(o), over || null);
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);
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

  // ═══ 1. Create a product via the REAL modal (kind toggle, sku, stock, cost) ═══
  await page.evaluate(() => switchScreen('services'));
  await page.waitForTimeout(150);
  await page.click('#s-services .btn-submit');
  await page.waitForSelector('#modal-service.open', { timeout: 5000 });
  const preToggleFieldsHidden = await page.evaluate(() => document.getElementById('svc-product-fields').style.display === 'none');
  assert(preToggleFieldsHidden, '1: product-only fields hidden by default in "Add service"');
  await page.click('#svc-kind-product');
  const postToggleState = await page.evaluate(() => ({
    fieldsShown: document.getElementById('svc-product-fields').style.display !== 'none',
    prodActive: document.getElementById('svc-kind-product').classList.contains('seg-active'),
    svcActive: document.getElementById('svc-kind-service').classList.contains('seg-active'),
    kindVal: document.getElementById('sv-kind').value,
  }));
  assert(postToggleState.fieldsShown, '1: product-only fields show after clicking the Product toggle');
  assert(postToggleState.prodActive && !postToggleState.svcActive, '1: Product toggle button is seg-active, Service is not');
  assert(postToggleState.kindVal === 'product', '1: hidden #sv-kind carries "product"');
  await page.fill('#sv-name', 'Protein Pack');
  await page.fill('#sv-rate', '250');
  await page.fill('#sv-unit', 'pack');
  await page.fill('#sv-sku', 'PRO-1');
  await page.fill('#sv-stock', '5');
  await page.fill('#sv-cost', '100');
  await page.click('#modal-service .btn-submit');
  await page.waitForTimeout(400);
  const proteinId = await page.evaluate(() => services.find(s => s.name === 'Protein Pack').id);
  const proteinRow = await svcRow(proteinId, 'JSON.stringify({kind:s.kind, sku:s.sku, stockQty:s.stockQty, cost:s.cost})')
    .then(JSON.parse);
  assert(proteinRow.kind === 'product', '1: saved record kind === "product", got ' + proteinRow.kind);
  assert(proteinRow.sku === 'PRO-1', '1: saved record sku preserved, got ' + proteinRow.sku);
  assert(proteinRow.stockQty === 5, '1: saved record stockQty === 5, got ' + proteinRow.stockQty);
  assert(proteinRow.cost === 100, '1: saved record cost === 100, got ' + proteinRow.cost);
  const listHtmlAfterCreate = await page.evaluate(() => document.getElementById('services-body').innerHTML);
  assert(listHtmlAfterCreate.includes('📦'), '1: product row renders the 📦 icon');
  assert(listHtmlAfterCreate.includes('5 left'), '1: product row shows the "5 left" stock chip, got html snippet ' +
    (listHtmlAfterCreate.match(/list-row[\s\S]{0,400}/) || [''])[0].slice(0, 200));

  // ═══ 2. Edit preserves kind/sku/stock ═════════════════════════════════
  await page.evaluate(id => openEditService(id), proteinId);
  await page.waitForSelector('#modal-service.open', { timeout: 5000 });
  const editState = await page.evaluate(() => ({
    kindVal: document.getElementById('sv-kind').value,
    prodActive: document.getElementById('svc-kind-product').classList.contains('seg-active'),
    sku: document.getElementById('sv-sku').value,
    stock: document.getElementById('sv-stock').value,
    fieldsShown: document.getElementById('svc-product-fields').style.display !== 'none',
  }));
  assert(editState.kindVal === 'product', '2: edit modal reopens with kind="product"');
  assert(editState.prodActive, '2: edit modal reopens with Product toggle seg-active');
  assert(editState.sku === 'PRO-1', '2: edit modal preserves sku, got ' + editState.sku);
  assert(editState.stock === '5', '2: edit modal preserves stock, got ' + editState.stock);
  assert(editState.fieldsShown, '2: edit modal shows product fields for a product record');
  await page.click('#modal-service button.btn-danger[style*="border-color"]'); // Cancel — no changes

  // ═══ 3. A legacy plain service (no `kind` field) still renders 🏷️, no chip ═
  await mkLegacyService();
  await page.waitForTimeout(150);
  const legacyHtml = await page.evaluate(() => document.getElementById('services-body').innerHTML);
  const legacyRowMatch = legacyHtml.match(/<div class="list-row"[^]*?Legacy Consulting[^]*?<\/div>\s*<\/div>/);
  assert(!!legacyRowMatch, '3: legacy service row rendered');
  if (legacyRowMatch) {
    assert(legacyRowMatch[0].includes('🏷️'), '3: legacy service row shows 🏷️, not 📦');
    assert(!legacyRowMatch[0].includes('class="chip"'), '3: legacy service row has no stock chip');
  }

  // ═══ 4. Invoice form: product appears in #inv-svc with 📦, picking it links the line ═
  await page.evaluate(() => switchScreen('invoices'));
  await page.waitForTimeout(150);
  await page.click('#inv-new-btn');
  await page.waitForSelector('#inv-form-modal.open', { timeout: 5000 });
  const svcOptionText = await page.evaluate(id => {
    const opt = document.querySelector(`#inv-svc option[value="${id}"]`);
    return opt ? opt.textContent : null;
  }, proteinId);
  assert(!!svcOptionText && svcOptionText.includes('📦'), '4: #inv-svc option for the product includes 📦, got ' + svcOptionText);
  await page.fill('#inv-cname', 'Catalog Client');
  await page.selectOption('#inv-svc', String(proteinId));
  await page.waitForTimeout(150);
  const linkedLineEl = await page.evaluate(id => !!document.querySelector(`.inv-line[data-service-id="${id}"]`), proteinId);
  assert(linkedLineEl, '4: picking the product creates a line row carrying data-service-id');
  // Bump qty to 2 on that line so decrement math is non-trivial.
  await page.evaluate(id => {
    const row = document.querySelector(`.inv-line[data-service-id="${id}"]`);
    const qtyInput = row.querySelector('input[data-f="qty"]');
    qtyInput.value = '2';
    qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
  }, proteinId);
  await page.click('#inv-save');
  await page.waitForTimeout(400);
  const savedInvId = await page.evaluate(async () => {
    const rows = await dbAll('invoices');
    const match = rows.filter(r => r.clientName === 'Catalog Client' && (r.lineItems || []).some(li => li.serviceId != null));
    match.sort((a, b) => b.id - a.id);
    return match[0].id;
  });
  const savedServiceId = await invRow(savedInvId, 'inv.lineItems[0].serviceId');
  assert(savedServiceId === proteinId, '4: saved invoice lineItems[0].serviceId === product id, got ' + savedServiceId);

  // ═══ 5. Mark paid via the detail modal → stock 5→3 for qty 2, stamped, toast ═
  await openInvoice(savedInvId);
  await page.selectOption('#inv-d-status', 'paid');
  await waitStamped(savedInvId);
  const afterPaid = await svcRow(proteinId, 's.stockQty');
  assert(afterPaid === 3, '5: stockQty 5 -> 3 after paying an invoice with qty 2, got ' + afterPaid);
  const stampedAt = await invRow(savedInvId, 'inv.stockDecrementedAt');
  assert(!!stampedAt, '5: invoice.stockDecrementedAt stamped, got ' + stampedAt);
  const decToastText = await page.locator('#toast').textContent();
  // {n} counts distinct catalog line items whose stock was touched (one
  // product line here, at qty 2 each) — not the summed unit quantity.
  assert(decToastText === 'Stock updated — 1 item(s) deducted', '5: decrement toast fired, got "' + decToastText + '"');

  // ═══ 6. Flip paid -> sent -> paid again: stock stays at 3 (no double decrement) ═
  await page.selectOption('#inv-d-status', 'sent');
  await page.waitForTimeout(300);
  await page.selectOption('#inv-d-status', 'paid');
  await page.waitForTimeout(600);
  const afterReflip = await svcRow(proteinId, 's.stockQty');
  assert(afterReflip === 3, '6: stockQty stays at 3 after paid -> sent -> paid, got ' + afterReflip);
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 7. Low-stock chip renders (amber) when 0 < n <= 3 — protein is now at 3 ═
  await page.evaluate(() => switchScreen('services'));
  await page.waitForTimeout(150);
  const lowStockHtml = await page.evaluate(() => document.getElementById('services-body').innerHTML);
  assert(lowStockHtml.includes('3 left') && lowStockHtml.includes('marigold-tint'),
    '7: low-stock (n=3) chip renders "3 left" with the amber marigold-tint styling');

  // ═══ 8. Stock floor: paid invoice with qty > remaining stock -> stockQty 0, not negative ═
  const soapId = await mkProduct({ name: 'Soap Bar', sku: 'SOAP-1', stockQty: 2, cost: 10 });
  const floorInvId = await mkInvoice({
    lineItems: [{ description: 'Soap Bar', qty: 5, unitPrice: 30, serviceId: soapId }],
    subtotal: 150, clientPays: 150, youReceive: 150, status: 'sent',
  });
  await openInvoice(floorInvId);
  await page.selectOption('#inv-d-status', 'paid');
  await waitStamped(floorInvId);
  const floorStock = await svcRow(soapId, 's.stockQty');
  assert(floorStock === 0, '8: stockQty floors at 0 (never negative) when paid qty exceeds remaining stock, got ' + floorStock);
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  await page.evaluate(() => switchScreen('services'));
  await page.waitForTimeout(150);
  const outOfStockHtml = await page.evaluate(() => document.getElementById('services-body').innerHTML);
  assert(outOfStockHtml.includes('Out of stock'), '8: services list shows "Out of stock" for the depleted product');

  await page.evaluate(() => switchScreen('invoices'));
  await page.waitForTimeout(150);
  await page.click('#inv-new-btn');
  await page.waitForSelector('#inv-form-modal.open', { timeout: 5000 });
  const soapOptionDisabled = await page.evaluate(id => {
    const opt = document.querySelector(`#inv-svc option[value="${id}"]`);
    return opt ? opt.disabled : null;
  }, soapId);
  assert(soapOptionDisabled === true, '8: #inv-svc option for the out-of-stock product is disabled');
  await page.click('#inv-cancel');
  await page.waitForTimeout(150);

  // ═══ 9. markJobPaid path: a pipeline job at 'paid' stage linked to a product ═══
  // invoice, advanced via the normal pipeline action, decrements stock too.
  const mopId = await mkProduct({ name: 'Mop Head', sku: 'MOP-1', stockQty: 4, cost: 20 });
  const jobInvId = await mkInvoice({
    lineItems: [{ description: 'Mop Head', qty: 1, unitPrice: 40, serviceId: mopId }],
    subtotal: 40, clientPays: 40, youReceive: 40, status: 'sent',
  });
  const jobId = await mkJob('paid', { invoiceId: jobInvId });
  await page.evaluate(id => pipelineAction(id), jobId);
  await waitStamped(jobInvId);
  await page.evaluate(() => { document.getElementById('modal-appt')?.remove(); }); // stage-gate popup from the advance
  const mopStock = await svcRow(mopId, 's.stockQty');
  assert(mopStock === 3, '9: markJobPaid path decrements linked product stock too (4 -> 3), got ' + mopStock);
  const jobInvStatus = await invRow(jobInvId, 'inv.status');
  assert(jobInvStatus === 'paid', '9: the linked invoice itself flipped to paid via markJobPaid, got ' + jobInvStatus);

  // ═══ 10. A hand-typed line (no serviceId) on a paid invoice: no stamp, no decrement ═
  const plainInvId = await mkInvoice({
    lineItems: [{ description: 'Hand-typed work, no catalog link', qty: 1, unitPrice: 1000 }],
    status: 'sent',
  });
  await openInvoice(plainInvId);
  await page.selectOption('#inv-d-status', 'paid');
  await page.waitForTimeout(600);
  const plainStamp = await invRow(plainInvId, 'inv.stockDecrementedAt');
  assert(!plainStamp, '10: an invoice with no product lines never gets stockDecrementedAt stamped, got ' + plainStamp);
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
