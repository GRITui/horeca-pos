const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // Register a local (client-only) account so isGuest is false (client cap /
  // logo gates only apply to non-guest accounts, same as the Subscription
  // screen itself).
  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'gate-test-' + Date.now());
  await page.fill('#auth-name', 'Gate Test');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#modal-persona-onboard .list-row:nth-child(1)'); // trainer
  await page.waitForTimeout(400);

  async function setEntitlements(user) {
    await page.evaluate((u) => {
      const noop = async () => ({ ok: true, data: {} });
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: u } }),
        billingCheckout: async () => ({ ok: false }),
        billingPortal: async () => ({ ok: false }),
        mirrorClientSave: noop, mirrorClientDelete: noop,
        mirrorJobSave: noop, mirrorJobDelete: noop,
        mirrorServiceSave: noop, mirrorServiceDelete: noop,
        mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
        mirrorDocumentSave: noop, mirrorDocumentDelete: noop,
        mirrorBookingSave: noop, mirrorBookingDelete: noop,
        mirrorFollowupSave: noop,
        mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
        mirrorResearchSave: noop, mirrorResearchDelete: noop,
        mirrorPackageSave: noop,
        mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop,
        mirrorSettingSave: noop,
      };
    }, user);
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.waitForTimeout(100);
  }

  const basicAtCap = {
    plan: 'basic', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: false, clientCap: 1,
    features: { cloudSync: false, lineBooking: false, recurringBookings: false, researchPremium: false, docBranding: false },
  };
  const proUnlocked = {
    plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: true, clientCap: null,
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };

  // ── 1. Client cap ──────────────────────────────────────────────────
  await setEntitlements(basicAtCap);
  // Add one client to reach the cap of 1.
  await page.evaluate(() => window.switchScreen && window.switchScreen('customers'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.openAddCustomer && window.openAddCustomer());
  await page.fill('#c-name', 'Client One');
  await page.evaluate(() => window.saveCustomer && window.saveCustomer());
  await page.waitForTimeout(300);
  let clientCount = await page.evaluate(async () => (await window.dbAll('clients')).length);
  assert(clientCount === 1, 'first client (at cap=1) is allowed, got count ' + clientCount);

  // Second client should be blocked by the cap.
  await page.evaluate(() => window.openAddCustomer && window.openAddCustomer());
  await page.fill('#c-name', 'Client Two');
  await page.evaluate(() => window.saveCustomer && window.saveCustomer());
  await page.waitForTimeout(300);
  clientCount = await page.evaluate(async () => (await window.dbAll('clients')).length);
  assert(clientCount === 1, 'second client blocked at cap, count should stay 1, got ' + clientCount);
  const toastText = await page.locator('#toast').textContent();
  assert(toastText && toastText.includes('ขีดจำกัด'), 'cap-reached toast shown, got: ' + toastText);

  // Editing the existing client (not adding a new one) must still work even at cap.
  await page.evaluate(async () => {
    const rows = await window.dbAll('clients');
    window.openEditCustomer(rows[0].id);
  });
  await page.waitForTimeout(150);
  await page.fill('#c-phone', '0899999999');
  await page.evaluate(() => window.saveCustomer && window.saveCustomer());
  await page.waitForTimeout(300);
  const editedPhone = await page.evaluate(async () => (await window.dbAll('clients'))[0].phone);
  assert(editedPhone === '0899999999', 'editing an existing client still works while at cap, got phone=' + editedPhone);

  // Now upgrade to Pro (unlimited) and confirm the second client can be added.
  await setEntitlements(proUnlocked);
  await page.evaluate(() => window.openAddCustomer && window.openAddCustomer());
  await page.fill('#c-name', 'Client Two Again');
  await page.evaluate(() => window.saveCustomer && window.saveCustomer());
  await page.waitForTimeout(300);
  clientCount = await page.evaluate(async () => (await window.dbAll('clients')).length);
  assert(clientCount === 2, 'unlimited plan allows adding beyond the old cap, got count ' + clientCount);

  // ── 2. Recurring bookings gate ─────────────────────────────────────
  await setEntitlements(basicAtCap);
  await page.evaluate(() => window.switchScreen && window.switchScreen('book'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.openBookingForm && window.openBookingForm());
  await page.waitForTimeout(200);
  const repeatDisabledOnBasic = await page.locator('#bk-repeat').isDisabled().catch(() => null);
  const repeatOptionCountBasic = await page.locator('#bk-repeat option').count().catch(() => -1);
  assert(repeatDisabledOnBasic === true, 'repeat select disabled on Basic, got ' + repeatDisabledOnBasic);
  assert(repeatOptionCountBasic === 1, 'only the "does not repeat" option present on Basic, got ' + repeatOptionCountBasic);

  await setEntitlements(proUnlocked);
  // Re-open the form fresh so it re-renders with the new entitlement state.
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => window.switchScreen && window.switchScreen('home'));
  await page.evaluate(() => window.switchScreen && window.switchScreen('book'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.openBookingForm && window.openBookingForm());
  await page.waitForTimeout(200);
  const repeatOptionCountPro = await page.locator('#bk-repeat option').count().catch(() => -1);
  assert(repeatOptionCountPro === 3, 'all 3 repeat options present on Pro, got ' + repeatOptionCountPro);

  // ── 3. Research premium via Pro plan ───────────────────────────────
  await setEntitlements(basicAtCap);
  await page.evaluate(() => window.switchScreen && window.switchScreen('research'));
  await page.waitForTimeout(200);
  const bannerBasic = await page.locator('#research-body').textContent();
  assert(bannerBasic && !bannerBasic.includes('Premium unlocked'), 'basic plan does not show "Premium unlocked" banner');

  await setEntitlements(proUnlocked);
  await page.evaluate(() => window.renderResearch && window.renderResearch());
  await page.waitForTimeout(200);
  const bannerPro = await page.locator('#research-body').textContent();
  assert(bannerPro && bannerPro.includes('Premium unlocked'), 'pro plan shows "Premium unlocked" banner via entitlement alone, got: ' + (bannerPro||'').slice(0,200));

  // ── 4. Seller logo gate ────────────────────────────────────────────
  await setEntitlements(basicAtCap);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const logoInputVisibleBasic = await page.locator('#seller-logo-input').count();
  assert(logoInputVisibleBasic === 0, 'logo upload hidden on Basic');
  const logoLockedTextBasic = await page.locator('#seller-logo-body').textContent();
  assert(logoLockedTextBasic && logoLockedTextBasic.length > 0, 'shows a locked note on Basic instead');

  await setEntitlements(proUnlocked);
  await page.evaluate(() => window.renderSellerLogoSection && window.renderSellerLogoSection());
  await page.waitForTimeout(200);
  const logoInputVisiblePro = await page.locator('#seller-logo-input').count();
  assert(logoInputVisiblePro === 1, 'logo upload shown on Pro');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
