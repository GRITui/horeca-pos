/* Acceptance suite for "Pass M2b — shareable client-facing public invoice
 * page": app/invoice.html + api/invoice-public.js (read + slip-upload) plus
 * the in-app "Copy link" share button (app/invoices.js). Harness pattern
 * copied from tests/check-payments.js / tests/check-book-page.js.
 *
 * window.fetch is stubbed IN-PAGE via page.addInitScript (not page.route)
 * so the exact request bodies invoice.html sends are captured verbatim,
 * and — just as important — so this proves invoices.js loads standalone
 * with zero network dependency for its QR-drawing pieces (SidekickPromptPay).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-invoice-public.js
 * Expects http://localhost:8963 serving ../app (invoice.html scenarios) and
 * http://localhost:8953 serving ../app (the in-app share-button scenario,
 * same port check-payments.js already uses).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8963';
const APP_BASE = 'http://localhost:8953'; // in-app share test reuses check-payments.js's port
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SCRATCH = '/tmp/claude-0/-home-user-Sidekickz/9dfe4fa3-fc03-50b9-b601-b8c41d1dc2c6/scratchpad';
const PNG_PATH = path.join(SCRATCH, 'invpub-slip-test.png');

// The exact GET payload api/invoice-public.js's whitelist would produce —
// 2 line items, a promptpay + paylink + bank channel, status 'sent'.
const BASE_GET_RESPONSE = {
  number: 'INV-2026-777',
  issueDate: '2026-07-01',
  dueDate: '2026-07-15',
  clientName: 'Acme Co., Ltd.',
  lineItems: [
    { description: 'Design work', qty: 1, unitPrice: 5000 },
    { description: 'Development', qty: 2, unitPrice: 2500 },
  ],
  subtotal: 10000,
  vatPct: 7, vat: 700,
  whtPct: 3, wht: 300,
  clientPays: 10400,
  depositPct: 0,
  status: 'sent',
  paymentChannels: [
    { id: 'pp1', type: 'promptpay', label: 'PromptPay', detail: '0812345678' },
    { id: 'pl1', type: 'paylink', label: 'Pay online', detail: 'https://pay.example.com/x' },
    { id: 'bk1', type: 'bank', label: 'Kasikorn Bank', detail: '123-4-56789-0\nSomchai Ltd.' },
  ],
  notes: 'Thanks for your business!',
  ownerName: 'Somchai',
  slipCount: 0,
};

// Installed via page.addInitScript BEFORE any page script runs, so
// window.fetch is already the stub by the time invoice.html's own inline
// script calls load(). `cfg` must be JSON-serializable.
function installFetchStub(cfg) {
  window.__posts = [];
  window.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/api/invoice-public') && method === 'GET') {
      return new Response(JSON.stringify(cfg.getResponse), {
        status: cfg.getStatus || 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/invoice-public') && method === 'POST') {
      window.__posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify(cfg.postResponse || { ok: true, slipCount: 1 }), {
        status: cfg.postStatus || 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

async function newStubbedPage(browser, cfg) {
  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  await page.addInitScript(installFetchStub, cfg);
  await page.goto(BASE + '/invoice.html?i=test-cuid-1');
  await page.waitForTimeout(500);
  return page;
}

(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(PNG_PATH, Buffer.from(PNG_B64, 'base64'));

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });

  // ═══ 1. Happy path: renders number/owner/total, QR non-blank, paylink ═
  const page1 = await newStubbedPage(browser, { getResponse: BASE_GET_RESPONSE });
  const bodyText1 = await page1.evaluate(() => document.body.textContent);
  assert(bodyText1.includes('INV-2026-777'), '1: invoice number rendered, got body missing it');
  assert(bodyText1.includes('Somchai'), '1: owner name rendered');
  assert(bodyText1.includes('10,400.00'), '1: total due (clientPays) rendered, got: ' + (bodyText1.match(/[\d,]+\.\d\d/g) || []).join(' '));
  assert(bodyText1.includes('Acme Co., Ltd.'), '1: client name rendered');

  const canvasInfo = await page1.evaluate(() => {
    const c = document.getElementById('ipub-qr-0');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let hasDark = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 100 && data[i + 3] > 0) { hasDark = true; break; }
    }
    return { width: c.width, height: c.height, hasDark };
  });
  assert(!!canvasInfo, '1: PromptPay QR canvas exists (#ipub-qr-0)');
  assert(canvasInfo && canvasInfo.width > 0, '1: QR canvas has nonzero width, got ' + (canvasInfo && canvasInfo.width));
  assert(canvasInfo && canvasInfo.hasDark, '1: QR canvas is non-blank (contains a dark pixel)');

  const payBtn = await page1.evaluate(() => {
    const a = document.querySelector('.ipub-paybtn');
    return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null;
  });
  assert(!!payBtn, '1: paylink channel renders a live "Pay now" anchor');
  assert(payBtn && payBtn.href === 'https://pay.example.com/x', '1: anchor href is the channel URL, got ' + JSON.stringify(payBtn));
  assert(payBtn && payBtn.target === '_blank', '1: anchor opens in a new tab');
  assert(payBtn && payBtn.rel.includes('noopener'), '1: anchor rel includes noopener');
  assert(bodyText1.includes('Kasikorn Bank') && bodyText1.includes('123-4-56789-0'), '1: bank channel renders as a plain reference card');

  // ═══ 2. A javascript: paylink renders as plain text, not a live link ═
  const badCfg = {
    getResponse: Object.assign({}, BASE_GET_RESPONSE, {
      paymentChannels: [{ id: 'pl2', type: 'paylink', label: 'Bad link', detail: 'javascript:alert(1)' }],
    }),
  };
  const page2 = await newStubbedPage(browser, badCfg);
  const badAnchorCount = await page2.evaluate(() => document.querySelectorAll('#ipub-channels a').length);
  const badWrapText = await page2.evaluate(() => document.getElementById('ipub-channels').textContent);
  assert(badAnchorCount === 0, '2: an unsafe (javascript:) paylink URL never renders a live anchor');
  assert(badWrapText.includes('javascript:alert(1)'), '2: it falls back to plain reference text instead, got: ' + badWrapText);
  await page2.close();

  // ═══ 3. Slip attach: downscale → POST body → success state ══════════
  const fileInput = page1.locator('#ipub-slip-file');
  await fileInput.setInputFiles(PNG_PATH);
  await page1.waitForTimeout(700);
  const posts = await page1.evaluate(() => window.__posts);
  assert(Array.isArray(posts) && posts.length === 1, '3: exactly one POST sent after attaching a slip, got ' + (posts && posts.length));
  assert(posts && posts[0] && posts[0].i === 'test-cuid-1', '3: POST carries the invoice cuid from ?i=, got ' + JSON.stringify(posts && posts[0] && posts[0].i));
  assert(posts && posts[0] && posts[0].dataUrl && posts[0].dataUrl.startsWith('data:image/jpeg'), '3: POST body dataUrl is a downscaled JPEG data URL, got prefix ' + (posts && posts[0] && posts[0].dataUrl && posts[0].dataUrl.slice(0, 20)));
  const successText = await page1.evaluate(() => document.getElementById('ipub-slip-status').textContent);
  assert(successText.includes('Slip sent') || successText.includes('ส่งสลิปแล้ว'), '3: success state shown after upload, got: ' + successText);
  await page1.close();

  // ═══ 4. A fake 409 (slips_full) shows the friendly bilingual message ═
  const fullCfg = {
    getResponse: Object.assign({}, BASE_GET_RESPONSE, { slipCount: 5 }),
    postStatus: 409,
    postResponse: { error: 'This invoice already has the maximum number of slips attached', code: 'slips_full' },
  };
  const page4 = await newStubbedPage(browser, fullCfg);
  const preCount = await page4.evaluate(() => document.getElementById('ipub-slip-status').textContent);
  assert(preCount.includes('5'), '4: "N slip(s) already attached" hint shows the slipCount from GET, got: ' + preCount);
  await page4.locator('#ipub-slip-file').setInputFiles(PNG_PATH);
  await page4.waitForTimeout(700);
  const toastText = await page4.locator('#toast').textContent();
  assert(toastText && (toastText.includes('maximum') || toastText.includes('สูงสุด')), '4: 409 slips_full shows a friendly bilingual toast, got: ' + toastText);
  await page4.close();

  // ═══ 5. Zero console/page errors across every invoice.html load ═════
  // (proves invoices.js — loaded for its SidekickPromptPay QR primitives —
  // runs standalone with no app.js present, per the file's own contract.)
  assert(errors.length === 0, '5: zero console/page errors across all invoice.html loads, got: ' + errors.join('; '));

  // ═══ 6. In-app "Copy link" share button (app/invoices.js) ═══════════
  const appPage = await browser.newPage();
  appPage.on('console', msg => { if (msg.type() === 'error') errors.push('[app] ' + msg.text()); });
  appPage.on('pageerror', err => errors.push('[app] ' + String(err)));

  await appPage.goto(APP_BASE + '/login.html');
  await appPage.click('#tab-register');
  await appPage.fill('#auth-user', 'invpub' + Date.now());
  await appPage.fill('#auth-name', 'Invoice Share Tester');
  await appPage.fill('#auth-pass', 'pass1234');
  await appPage.fill('#auth-confirm', 'pass1234');
  await appPage.click('#auth-submit');
  await appPage.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await appPage.click('#modal-persona-onboard .list-row:nth-child(1)');
  await appPage.waitForTimeout(500);
  await appPage.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await appPage.evaluate(async () => { await onLangChange('en'); });
  await appPage.waitForTimeout(200);

  // Deterministic backend stub — isEnabled forced true regardless of real
  // network reachability, same Object.assign-over-the-real-object pattern
  // as tests/check-blockers-p1.js §6, so mirrorInvoiceSave etc. (unused by
  // this scenario) stay intact.
  await appPage.evaluate(() => {
    const base = window.SidekickBackend || {};
    window.SidekickBackend = Object.assign({}, base, {
      isEnabled: () => true,
      invoiceFetchByCuid: async () => null,
    });
  });

  const invId = await appPage.evaluate(async () => {
    const uid = currentUser.id;
    const base = {
      uid, number: 'INV-SHARE-1', issueDate: todayISO(), dueDate: '',
      clientId: null, clientName: 'Share Client', clientTaxId: '', clientAddress: '',
      lineItems: [{ description: 'Work', qty: 1, unitPrice: 500 }], subtotal: 500,
      whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 500, youReceive: 500, depositPct: 0,
      status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(),
    };
    return dbAdd('invoices', base);
  });
  await appPage.evaluate(() => switchScreen('invoices'));
  await appPage.waitForTimeout(200);
  await appPage.evaluate(id => document.querySelector(`[data-inv="${id}"]`)?.click(), invId);
  await appPage.waitForSelector('#inv-detail-modal.open', { timeout: 5000 });

  const shareBtnExists = await appPage.evaluate(() => !!document.getElementById('inv-d-share'));
  assert(shareBtnExists, '6: "Copy link" button (#inv-d-share) renders on invoice detail when backend is enabled');

  await appPage.evaluate(() => {
    window.__copiedText = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text) => { window.__copiedText = text; } },
      configurable: true,
    });
  });
  await appPage.click('#inv-d-share');
  await appPage.waitForTimeout(300);
  const copied = await appPage.evaluate(() => window.__copiedText);
  assert(!!copied && copied.includes('invoice.html?i='), '6: clicking Copy link copies a URL containing invoice.html?i=, got ' + copied);
  const shareToast = await appPage.locator('#toast').textContent();
  assert(shareToast === 'Invoice link copied — send it to your client', '6: share toast fired, got "' + shareToast + '"');
  await appPage.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
