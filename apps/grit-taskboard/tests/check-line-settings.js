const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'line-test-' + Date.now());
  await page.fill('#auth-name', 'Line Test');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(400);
  // Dismiss the first-login "enable cloud backup?" modal if it appeared —
  // it'd otherwise sit on top of the page intercepting every later click.
  await page.evaluate(() => { const m = document.getElementById('cloud-backup-modal'); if (m) m.remove(); });

  const basicPlan = {
    plan: 'basic', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: false, clientCap: 15,
    features: { cloudSync: false, lineBooking: false, recurringBookings: false, researchPremium: false, docBranding: false },
  };
  const proPlan = {
    plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: true, clientCap: null,
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };

  let lineConnected = null; // server-side fake state
  let slots = [];
  let nextSlotId = 1;

  async function setEntitlements(user) {
    await page.evaluate((u) => {
      const noop = async () => ({ ok: true, data: {} });
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: u } }),
        billingCheckout: async () => ({ ok: false }), billingPortal: async () => ({ ok: false }),
        mirrorClientSave: noop, mirrorClientDelete: noop, mirrorJobSave: noop, mirrorJobDelete: noop,
        mirrorServiceSave: noop, mirrorServiceDelete: noop, mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
        mirrorDocumentSave: noop, mirrorDocumentDelete: noop, mirrorBookingSave: noop, mirrorBookingDelete: noop,
        mirrorFollowupSave: noop, mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
        mirrorResearchSave: noop, mirrorResearchDelete: noop, mirrorPackageSave: noop,
        mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop, mirrorSettingSave: noop,
        // Fake server-side LINE connect + slots state, driven from this test's
        // own in-page closures below (set via window.__fake*).
        lineChannelStatus: async () => ({ ok: true, data: await window.__fakeLineStatus() }),
        lineChannelConnect: async (payload) => ({ ok: true, data: await window.__fakeLineConnect(payload) }),
        lineChannelDisconnect: async () => { await window.__fakeLineDisconnect(); return { ok: true, data: { connected: false } }; },
        bookingSlotsList: async () => ({ ok: true, data: { rows: await window.__fakeSlotsList() } }),
        bookingRequestsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestResolve: async () => ({ ok: true, data: {} }),
        bookingSlotCreate: async (payload) => ({ ok: true, data: { row: await window.__fakeSlotCreate(payload) } }),
        bookingSlotDelete: async (id) => { await window.__fakeSlotDelete(id); return { ok: true, data: { deleted: true } }; },
      };
    }, user);
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.waitForTimeout(100);
  }

  // Wire the fake backend state into the page (Node-side closures exposed via exposeFunction).
  await page.exposeFunction('__fakeLineStatus', () => lineConnected
    ? { connected: true, channelId: lineConnected.channelId, botUserId: 'U_bot_1', freelancerLineUserId: lineConnected.freelancerLineUserId || null, webhookUrl: 'https://sidekickz.vercel.app/api/line-webhook', bookingPageUrl: 'https://gritui.github.io/Sidekickz/book.html?u=test-cuid' }
    : { connected: false, webhookUrl: 'https://sidekickz.vercel.app/api/line-webhook', bookingPageUrl: 'https://gritui.github.io/Sidekickz/book.html?u=test-cuid' });
  await page.exposeFunction('__fakeLineConnect', (payload) => {
    lineConnected = { channelId: payload.channelId, freelancerLineUserId: payload.freelancerLineUserId };
    return { connected: true, channelId: payload.channelId, botUserId: 'U_bot_1', webhookUrl: 'https://sidekickz.vercel.app/api/line-webhook', bookingPageUrl: 'https://gritui.github.io/Sidekickz/book.html?u=test-cuid' };
  });
  await page.exposeFunction('__fakeLineDisconnect', () => { lineConnected = null; });
  await page.exposeFunction('__fakeSlotsList', () => slots);
  await page.exposeFunction('__fakeSlotCreate', (payload) => {
    const row = { id: nextSlotId++, starts_at: payload.startsAt, ends_at: payload.endsAt, status: 'open' };
    slots.push(row);
    return row;
  });
  await page.exposeFunction('__fakeSlotDelete', (id) => { slots = slots.filter(s => s.id !== id); });

  // ── 1. Basic plan: locked note, no connect form ────────────────────
  await setEntitlements(basicPlan);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const connectFormOnBasic = await page.locator('#line-ch-id').count();
  assert(connectFormOnBasic === 0, 'connect form hidden on Basic plan');
  const lockedTextBasic = await page.locator('#line-channel-body').textContent();
  assert(lockedTextBasic && lockedTextBasic.length > 0, 'shows a locked note on Basic instead');

  // ── 2. Pro plan, not yet connected: connect form appears ──────────
  await setEntitlements(proPlan);
  await page.evaluate(() => window.renderLineChannelSection && window.renderLineChannelSection());
  await page.waitForTimeout(200);
  const connectFormOnPro = await page.locator('#line-ch-id').count();
  assert(connectFormOnPro === 1, 'connect form shown on Pro plan when not connected');

  // ── 3. Connect flow ─────────────────────────────────────────────────
  await page.fill('#line-ch-id', '1234567890');
  await page.fill('#line-ch-secret', 'supersecretvalue');
  await page.fill('#line-ch-alert-uid', 'Ufreelanceruserid');
  await page.click('button:has-text("เชื่อมต่อ")'); // Thai default language: line_connect_btn
  await page.waitForTimeout(300);
  const webhookUrlVisible = await page.locator('input[value*="line-webhook"]').count();
  assert(webhookUrlVisible === 1, 'webhook URL shown after connecting');
  const bookingPageUrlVisible = await page.locator('input[value*="book.html"]').count();
  assert(bookingPageUrlVisible === 1, 'booking page URL shown after connecting');
  const disconnectBtnVisible = await page.locator('button:has-text("ยกเลิกการเชื่อมต่อ")').count();
  assert(disconnectBtnVisible === 1, 'disconnect button shown after connecting');

  // ── 4. Slot management: add + list + delete ─────────────────────────
  assert(slots.length === 0, 'starts with zero slots');
  const startVal = '2026-08-01T10:00';
  const endVal = '2026-08-01T11:00';
  await page.fill('#slot-start-input', startVal);
  await page.fill('#slot-end-input', endVal);
  await page.click('button:has-text("เพิ่มช่วงเวลา")');
  await page.waitForTimeout(200);
  assert(slots.length === 1, 'one slot added, got ' + slots.length);
  const slotRowCount = await page.locator('#booking-slots-body .list-row').count();
  assert(slotRowCount === 1, 'one slot row rendered, got ' + slotRowCount);

  // end-before-start validation
  await page.fill('#slot-start-input', '2026-08-01T12:00');
  await page.fill('#slot-end-input', '2026-08-01T11:00');
  await page.click('button:has-text("เพิ่มช่วงเวลา")');
  await page.waitForTimeout(200);
  assert(slots.length === 1, 'end-before-start slot rejected client-side, still only 1 slot, got ' + slots.length);

  // delete
  await page.click('#booking-slots-body .list-row button[aria-label="Delete"]');
  await page.waitForTimeout(200);
  assert(slots.length === 0, 'slot deleted, got ' + slots.length);

  // ── 5. Disconnect ────────────────────────────────────────────────────
  page.once('dialog', d => d.accept());
  await page.click('button:has-text("ยกเลิกการเชื่อมต่อ")');
  await page.waitForTimeout(300);
  const connectFormAfterDisconnect = await page.locator('#line-ch-id').count();
  assert(connectFormAfterDisconnect === 1, 'connect form reappears after disconnect');
  assert(lineConnected === null, 'server-side fake state cleared on disconnect');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
