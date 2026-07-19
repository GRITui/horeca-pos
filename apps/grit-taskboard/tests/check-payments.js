/* Acceptance suite for "Pass M2a — revenue loop part 1": the 'paylink'
 * payment-channel type (Task A) and payment-slip attach/confirm on invoices
 * (Task B). Harness pattern copied from tests/check-ux-flow.js.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-payments.js
 * Expects http://localhost:8953 serving ../app.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8953';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

// A real (tiny, valid) 1x1 red PNG — setInputFiles needs an actual file on
// disk, not a synthesized Blob, to exercise the FileReader path honestly.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SCRATCH = '/tmp/claude-0/-home-user-Sidekickz/9dfe4fa3-fc03-50b9-b601-b8c41d1dc2c6/scratchpad';
const PNG_PATH = path.join(SCRATCH, 'slip-test.png');
const TXT_PATH = path.join(SCRATCH, 'slip-test.txt');

(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(PNG_PATH, Buffer.from(PNG_B64, 'base64'));
  fs.writeFileSync(TXT_PATH, 'not an image');

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('dialog', d => d.accept());   // slip-remove confirm() guard

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'paytest' + Date.now());
  await page.fill('#auth-name', 'Payments Tester');
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

  // In-page invoice factory — window props die on page.reload(), so
  // installation is a re-runnable function per the harness convention.
  const installHelpers = () => page.evaluate(() => {
    window.__mkInvoice = async function (over) {
      const uid = currentUser.id;
      const base = {
        uid, number: 'INV-' + Math.random().toString(36).slice(2, 8), issueDate: todayISO(), dueDate: '',
        clientId: null, clientName: 'Payments Client', clientTaxId: '', clientAddress: '',
        lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], subtotal: 1000,
        whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1000, youReceive: 1000, depositPct: 0,
        status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(),
      };
      const id = await dbAdd('invoices', Object.assign(base, over || {}));
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkInvoice = (over) => page.evaluate(o => window.__mkInvoice(o), over || null);
  const openInvoice = async (id) => {
    await page.evaluate(() => switchScreen('invoices'));
    await page.waitForTimeout(200);
    await page.evaluate(invId => document.querySelector(`[data-inv="${invId}"]`)?.click(), id);
    await page.waitForSelector('#inv-detail-modal.open', { timeout: 5000 });
  };
  const invoiceRow = (id, expr) => page.evaluate(async args => {
    const inv = await dbGet('invoices', args[0]);
    return eval(args[1]);
  }, [id, expr]);

  // ═══ 1. Settings → payment channels: 'paylink' type exists + creates ═══
  await page.evaluate(() => switchScreen('more'));
  await page.waitForTimeout(200);
  await page.evaluate(() => openAddPaymentChannel());
  await page.waitForSelector('#modal-paychannel.open', { timeout: 5000 });
  const hasPaylinkOption = await page.evaluate(() => !!document.querySelector('#pc-type option[value="paylink"]'));
  assert(hasPaylinkOption, "1: 'paylink' appears in the payment-channel type select");
  await page.selectOption('#pc-type', 'paylink');
  await page.fill('#pc-detail', 'https://example.com/pay');
  await page.click('#modal-paychannel button.btn-submit');
  await page.waitForTimeout(300);
  const settingsListHtml = await page.evaluate(() => document.getElementById('payment-channels-list').innerHTML);
  assert(settingsListHtml.includes('Payment link') && settingsListHtml.includes('https://example.com/pay'),
    '1: newly-created paylink channel renders in the Settings list');

  // ═══ 2. Invoice detail renders the "Pay now" anchor for a paylink ═════
  const invGood = await mkInvoice({
    paymentChannels: [{ id: 'pl1', type: 'paylink', label: 'Payment link', detail: 'https://example.com/pay' }],
  });
  await openInvoice(invGood);
  const payBtn = await page.evaluate(() => {
    const a = document.querySelector('#inv-qr-wrap a');
    return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent } : null;
  });
  assert(!!payBtn, '2: a valid paylink channel renders a live <a> "Pay now" button');
  assert(payBtn && payBtn.href === 'https://example.com/pay', '2: anchor href is the channel URL, got ' + JSON.stringify(payBtn));
  assert(payBtn && payBtn.target === '_blank', '2: anchor opens in a new tab (target=_blank)');
  assert(payBtn && payBtn.rel.includes('noopener'), '2: anchor rel includes noopener, got ' + (payBtn && payBtn.rel));
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 3. A javascript: paylink renders as plain text, not a live link ══
  const invBad = await mkInvoice({
    paymentChannels: [{ id: 'pl2', type: 'paylink', label: 'Bad link', detail: 'javascript:alert(1)' }],
  });
  await openInvoice(invBad);
  const badAnchorCount = await page.evaluate(() => document.querySelectorAll('#inv-qr-wrap a').length);
  const badWrapText = await page.evaluate(() => document.getElementById('inv-qr-wrap').textContent);
  assert(badAnchorCount === 0, '3: an unsafe (javascript:) paylink URL never renders a live anchor');
  assert(badWrapText.includes('javascript:alert(1)'), '3: it falls back to the plain-text reference card instead');
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 4. Slip attach: downscales to JPEG, shows a thumbnail, toasts ════
  const invSlip = await mkInvoice({ status: 'sent' });
  await openInvoice(invSlip);
  await page.setInputFiles('#inv-slip-file', PNG_PATH);
  await page.waitForTimeout(600);
  const thumbCount = await page.evaluate(() => document.querySelectorAll('#inv-slip-wrap img[data-slip-view]').length);
  assert(thumbCount === 1, '4: a thumbnail appears after attaching a slip, got ' + thumbCount);
  const slipsAfterAttach = await invoiceRow(invSlip, 'inv.slips');
  assert(Array.isArray(slipsAfterAttach) && slipsAfterAttach.length === 1, '4: inv.slips has one entry in IndexedDB');
  assert(slipsAfterAttach && slipsAfterAttach[0].dataUrl.startsWith('data:image/jpeg'),
    '4: stored slip is a JPEG data URL (downscale ran), got prefix ' + (slipsAfterAttach && slipsAfterAttach[0].dataUrl.slice(0, 20)));
  const attachToast = await page.locator('#toast').textContent();
  assert(attachToast === 'Slip attached', '4: attach toast fired, got "' + attachToast + '"');

  // ═══ 4b. A non-image file is rejected, not attached ═══════════════════
  await page.setInputFiles('#inv-slip-file', TXT_PATH);
  await page.waitForTimeout(400);
  const invalidToast = await page.locator('#toast').textContent();
  assert(invalidToast === 'That file could not be read as an image', '4b: invalid-file toast fired, got "' + invalidToast + '"');
  const slipsAfterInvalid = await invoiceRow(invSlip, 'inv.slips');
  assert(slipsAfterInvalid.length === 1, '4b: rejected file did not get attached, slips count stayed at 1');

  // ═══ 5. Slip remove (confirm() accepted via page.on('dialog')) ════════
  await page.click('#inv-slip-wrap [data-slip-remove]');
  await page.waitForTimeout(400);
  const removedThumbCount = await page.evaluate(() => document.querySelectorAll('#inv-slip-wrap img[data-slip-view]').length);
  assert(removedThumbCount === 0, '5: thumbnail gone from the DOM after remove');
  const slipsAfterRemove = await invoiceRow(invSlip, 'inv.slips');
  assert(Array.isArray(slipsAfterRemove) && slipsAfterRemove.length === 0, '5: slip removed from the IndexedDB record');
  const removeToast = await page.locator('#toast').textContent();
  assert(removeToast === 'Slip removed', '5: remove toast fired, got "' + removeToast + '"');
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 6. Confirm paid: reuses the status-select transition + reverse hook ═
  const setup6 = await page.evaluate(async () => {
    const uid = currentUser.id;
    const invId = await window.__mkInvoice({ status: 'sent', clientPays: 900, youReceive: 900 });
    const jobId = await dbPut('jobs', {
      uid, date: todayISO(), client: 'Confirm Client', clientId: null, serviceId: null,
      serviceName: 'Confirm job', amount: 900, tip: 0, expense: 0, count: 1, notes: '', netAmount: 900,
      cuid: cuid(), stageOrder: getStageOrder().slice(), stage: 'paid', complete: false,
      invoiceId: invId, quoteDocId: null, packageId: null, updatedAt: nowISO(),
    });
    await reload();
    return { invId, jobId };
  });
  await openInvoice(setup6.invId);
  const confirmVisibleBefore = await page.evaluate(() => !!document.getElementById('inv-slip-confirm-paid'));
  assert(confirmVisibleBefore, '6: "Confirm payment received" button shows on an unpaid invoice');
  await page.click('#inv-slip-confirm-paid');
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('modal-appt')?.remove(); }); // stage-gate popup from the advance
  const after6 = await page.evaluate(async (ids) => {
    const inv = await dbGet('invoices', ids.invId);
    const j = jobs.find(x => x.id === ids.jobId);
    return { invStatus: inv.status, jobStage: j ? jobStage(j) : null };
  }, setup6);
  assert(after6.invStatus === 'paid', '6: invoice status flips to paid, got ' + after6.invStatus);
  assert(after6.jobStage !== 'paid', '6: the linked job advanced past its paid stage (onInvoiceMarkedPaid fired), stayed at ' + after6.jobStage);
  const statusSelectValue = await page.evaluate(() => document.getElementById('inv-d-status').value);
  assert(statusSelectValue === 'paid', '6: the status <select> in the open modal reflects paid');
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);
  await openInvoice(setup6.invId);
  const confirmVisibleAfter = await page.evaluate(() => !!document.getElementById('inv-slip-confirm-paid'));
  assert(!confirmVisibleAfter, '6: Confirm button no longer shown on reopen once the invoice is paid');
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 7. Persistence: slips array survives a page reload ═══════════════
  const invPersist = await mkInvoice({ status: 'sent' });
  await openInvoice(invPersist);
  await page.setInputFiles('#inv-slip-file', PNG_PATH);
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => { try { return typeof currentUser !== 'undefined' && !!currentUser; } catch (e) { return false; } }, null, { timeout: 20000 });
  await installHelpers();
  const persisted = await page.evaluate(async id => {
    const inv = await dbGet('invoices', id);
    return { count: (inv.slips || []).length, dataUrl: inv.slips && inv.slips[0] ? inv.slips[0].dataUrl : null };
  }, invPersist);
  assert(persisted.count === 1, '7: invoice slips array survives a page reload, got count ' + persisted.count);
  assert(!!persisted.dataUrl && persisted.dataUrl.startsWith('data:image/jpeg'),
    '7: the reloaded slip is still a JPEG data URL, got prefix ' + (persisted.dataUrl && persisted.dataUrl.slice(0, 20)));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
