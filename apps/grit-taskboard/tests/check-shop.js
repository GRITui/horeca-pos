/* Acceptance suite for "Pass M3-L3": the public storefront. Part 1 drives
 * app/shop.html standalone (public, unauthenticated — same page.route stub
 * pattern as tests/check-book-page.js). Part 2 drives the in-app Settings ▸
 * Shop section and the Confirm materialization path (the M3-L2 payoff:
 * items[] resolved to local serviceIds on a confirmed order) — harness
 * pattern copied from tests/check-items.js / tests/check-team.js.
 *
 * Starts its own static server (no other suite claims port 8993).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-shop.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8993;
const BASE = 'http://localhost:' + PORT;
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

function waitForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      const req = http.get(url, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('static server did not start on ' + url));
        else setTimeout(tick, 200);
      });
    })();
  });
}

(async () => {
  const appDir = path.join(__dirname, '..', 'app');
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', appDir], { stdio: 'ignore' });
  try {
    await waitForServer(BASE + '/login.html', 15000);
  } catch (e) {
    console.log('FAIL: ' + e.message);
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });

  // ═══ PART 1: app/shop.html standalone (public, unauthenticated) ════════
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(String(err)));

    const catalog = {
      ownerName: 'Somchai Shop',
      products: [
        { cuid: 'prod-tracked', name: 'Protein Pack', unit: 'pack', rate: 150, sku: 'PRO-1', stockQty: 3 },
        { cuid: 'prod-untracked', name: 'Shaker', unit: 'ea', rate: 80, sku: 'SHK-1', stockQty: null },
      ],
    };
    let lastOrderBody = null;
    let orderPostCount = 0;
    await page.route('**/api/shop-public*', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) });
      } else {
        orderPostCount++;
        lastOrderBody = JSON.parse(req.postData());
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
    });

    await page.goto(BASE + '/shop.html?u=owner-cuid-1');
    await page.waitForTimeout(400);
    assert(await page.locator('.shop-card').count() === 2, '1: both products rendered as cards');
    assert(errors.length === 0, '1: no console errors after initial load, got: ' + errors.join('; '));

    // Stepper clamps at the tracked product's stockQty (3).
    const trackedCard = page.locator('.shop-card[data-cuid="prod-tracked"]');
    // 5 attempts against stock 3 — the + button disables at the clamp (asserted
    // below), so the extra clicks must tolerate a no-longer-clickable target.
    for (let i = 0; i < 5; i++) await trackedCard.locator('.qty-btn[data-step="1"]').click({ timeout: 700 }).catch(() => {});
    const trackedCount = (await trackedCard.locator('.qty-count').textContent()).trim();
    assert(trackedCount === '3', '2: stepper clamps at stockQty 3, got ' + trackedCount);
    assert(await trackedCard.locator('.qty-btn[data-step="1"]').isDisabled(), '2: + button disables once clamped at the stock limit');

    // Running total updates as the untracked product is added too.
    const untrackedCard = page.locator('.shop-card[data-cuid="prod-untracked"]');
    await untrackedCard.locator('.qty-btn[data-step="1"]').click();
    await untrackedCard.locator('.qty-btn[data-step="1"]').click();
    await page.waitForTimeout(150);
    const barTotal = await page.locator('.shop-bar-total').textContent();
    // 3×150 + 2×80 = 610
    assert(barTotal.includes('610'), '3: running total reflects both line items (450+160=610), got ' + barTotal);

    // Order form requires a name — no POST fires without one.
    await page.click('#shop-order-btn');
    await page.waitForTimeout(200);
    await page.click('#shop-submit');
    await page.waitForTimeout(200);
    assert(orderPostCount === 0, '4: submitting with no name sends no POST');
    const toastNoName = await page.locator('#toast').textContent();
    assert(toastNoName && toastNoName.length > 0, '4: missing-name shows a guidance toast, got: ' + toastNoName);

    // Happy path: POST body carries only {cuid, qty} per item — never a price.
    await page.fill('#shop-name', 'Client Tester');
    await page.fill('#shop-contact', 'line:tester');
    await page.click('#shop-submit');
    await page.waitForTimeout(400);
    assert(orderPostCount === 1, '5: exactly one order POST sent');
    assert(lastOrderBody.name === 'Client Tester' && lastOrderBody.contact === 'line:tester', '5: name/contact sent as typed, got ' + JSON.stringify(lastOrderBody));
    assert(Array.isArray(lastOrderBody.items) && lastOrderBody.items.length === 2, '5: two item lines sent, got ' + JSON.stringify(lastOrderBody.items));
    const keysOk = lastOrderBody.items.every(it => Object.keys(it).sort().join(',') === 'cuid,qty');
    assert(keysOk, '5: each item carries only cuid+qty, never a client-side price, got ' + JSON.stringify(lastOrderBody.items));

    // Success state renders, still zero console errors.
    const confirmText = await page.locator('.shop-confirm').textContent();
    assert(confirmText && confirmText.length > 0, '6: success state rendered after order submit, got: ' + confirmText);
    assert(errors.length === 0, '6: no console errors across the whole shop.html flow, got: ' + errors.join('; '));

    await page.close();
  }

  // ═══ PART 2: in-app Settings ▸ Shop + Confirm materialization ══════════
  {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(String(err)));

    await page.goto(BASE + '/login.html');
    await page.click('#tab-register');
    await page.fill('#auth-user', 'shop' + Date.now());
    await page.fill('#auth-name', 'Shop Tester');
    await page.fill('#auth-pass', 'pass1234');
    await page.fill('#auth-confirm', 'pass1234');
    await page.click('#auth-submit');
    await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
    await page.click('#modal-persona-onboard .list-row:nth-child(1)');
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
    await page.evaluate(async () => { await onLangChange('en'); });
    await page.waitForTimeout(200);

    // A local product whose cuid matches the fake order's service_cuid, so
    // Confirm's local resolution (services.find(s => s.cuid === ...)) has
    // something real on this device to resolve to.
    const productId = await page.evaluate(async () => {
      const uid = currentUser.id;
      const obj = {
        uid, name: 'Protein Pack', rate: 150, unit: 'pack', usageQty: 1,
        kind: 'product', sku: 'PRO-1', stockQty: 5, cuid: 'local-product-cuid-1', updatedAt: nowISO(),
      };
      const id = await dbAdd('services', obj);
      await reload();
      return id;
    });

    await page.evaluate((productCuid) => {
      const noop = async () => ({ ok: true, data: {} });
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: {
          cuid: 'owner-cuid-shop-test', plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
          hasStripeCustomer: false, clientCap: null, team: null,
          features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
        } } }),
        billingCheckout: noop, billingPortal: noop,
        mirrorClientSave: noop, mirrorClientDelete: noop, mirrorJobSave: noop, mirrorJobDelete: noop,
        mirrorServiceSave: noop, mirrorServiceDelete: noop, mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
        mirrorDocumentSave: noop, mirrorDocumentDelete: noop, mirrorBookingSave: noop, mirrorBookingDelete: noop,
        mirrorFollowupSave: noop, mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
        mirrorResearchSave: noop, mirrorResearchDelete: noop, mirrorPackageSave: noop,
        mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop, mirrorSettingSave: noop,
        lineChannelStatus: async () => ({ ok: true, data: { connected: false } }),
        bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestResolve: async () => ({ ok: true, data: {} }),
        orderRequestsList: async () => ({ ok: true, data: { rows: [{
          id: 42, clientName: 'Order Client', contact: 'line:orderclient',
          items: [{ service_cuid: productCuid, name: 'Protein Pack', qty: 2, unit_price: 150 }],
          total: 300, createdAt: new Date().toISOString(),
        }] } }),
        orderRequestResolve: async (id, action) => {
          window.__resolveCalls = window.__resolveCalls || [];
          window.__resolveCalls.push({ id, action });
          return { ok: true, data: { ok: true, status: action === 'confirm' ? 'confirmed' : 'declined' } };
        },
      };
    }, 'local-product-cuid-1');
    // Explicit await, same as tests/check-team.js's setEntitlements() —
    // __entitlements is populated at real app boot before Settings is ever
    // visited; this test swaps SidekickBackend in AFTER boot, so it has to
    // refresh it itself before switchScreen('more') reads it synchronously.
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
    await page.waitForTimeout(500);

    // Shop link renders with the account's own cuid.
    const linkVal = await page.locator('#shop-link-body input[readonly]').inputValue().catch(() => '');
    assert(linkVal.includes('shop.html?u=owner-cuid-shop-test'), '7: shop link carries the account cuid, got: ' + linkVal);

    // The pending order row renders with client/contact/summary/total.
    const ordersHtml = await page.evaluate(() => document.getElementById('shop-orders-body').innerHTML);
    assert(ordersHtml.includes('Order Client') && ordersHtml.includes('line:orderclient'), '8: order row shows client name + contact, got snippet: ' + ordersHtml.slice(0, 300));
    assert(ordersHtml.includes('2×') && ordersHtml.includes('Protein Pack'), '8: order row summarizes items ("2× Protein Pack"-shape), got snippet: ' + ordersHtml.slice(0, 300));
    assert(ordersHtml.includes('300'), '8: order row shows the total');

    // Confirm materializes a local pipeline job with items[] resolved to
    // the LOCAL numeric serviceId, amount = total, and fires the toast.
    await page.click('button[onclick="resolveOrderRequest(42,\'confirm\')"]');
    await page.waitForTimeout(500);

    const resolveCalls = await page.evaluate(() => window.__resolveCalls || []);
    assert(resolveCalls.length === 1 && resolveCalls[0].id === 42 && resolveCalls[0].action === 'confirm',
      '9: Confirm called orderRequestResolve(42, "confirm"), got ' + JSON.stringify(resolveCalls));

    const newJob = await page.evaluate(() => new Promise(res => {
      const req = indexedDB.open('sidekick-v1');
      req.onsuccess = () => {
        const tx = req.result.transaction('jobs', 'readonly');
        tx.objectStore('jobs').getAll().onsuccess = e => {
          const rows = e.target.result;
          res(rows.find(j => j.shopOrderId === 42) || null);
        };
      };
    }));
    assert(!!newJob, '10: a job was created for the confirmed order');
    assert(newJob && newJob.client === 'Order Client', '10: job.client is the order client_name, got ' + (newJob && newJob.client));
    assert(newJob && newJob.amount === 300, '10: job.amount === order total (300), got ' + (newJob && newJob.amount));
    assert(newJob && Array.isArray(newJob.items) && newJob.items.length === 1, '10: job carries one items[] entry');
    assert(newJob && newJob.items[0].serviceId === productId, '10: item.serviceId resolved to the LOCAL numeric services id, got ' + (newJob && JSON.stringify(newJob.items[0])));
    assert(newJob && newJob.items[0].qty === 2 && newJob.items[0].unitPrice === 150, '10: item qty/unitPrice snapshot preserved, got ' + (newJob && JSON.stringify(newJob.items[0])));
    assert(newJob && newJob.notes && newJob.notes.includes('line:orderclient'), '10: job.notes carries the contact, got ' + (newJob && newJob.notes));

    const toastText = await page.locator('.toast').textContent().catch(() => '');
    assert(toastText && toastText.length > 0, '11: a confirmation toast fired, got: ' + toastText);

    assert(errors.length === 0, '12: no console errors across the whole in-app flow, got: ' + errors.join('; '));

    await page.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  server.kill();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); server_kill_safe(); process.exit(1); });

function server_kill_safe() {}
