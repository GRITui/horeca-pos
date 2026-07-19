const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // renderSubscriptionSection() early-returns for guest mode (a subscription
  // needs a real, non-guest account) — register a local (client-only, no
  // backend call) password account instead of using guest login, so isGuest
  // is false and the section actually renders.
  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'sub-ui-test-' + Date.now());
  await page.fill('#auth-name', 'Sub Test');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(400);

  // Stub SidekickBackend so we can drive renderSubscriptionSection() without a real backend.
  const scenarios = [
    {
      name: 'trialing, 8 days left',
      user: { plan: 'basic', subscriptionStatus: 'trialing', trialDaysLeft: 8, locked: false, hasStripeCustomer: false },
      expectLocked: false, expectUpgrade: true, expectManage: false,
    },
    {
      name: 'active pro',
      user: { plan: 'pro', subscriptionStatus: 'active', trialDaysLeft: null, locked: false, hasStripeCustomer: true },
      expectLocked: false, expectUpgrade: false, expectManage: true,
    },
    {
      name: 'locked (trial expired)',
      user: { plan: 'basic', subscriptionStatus: 'trialing', trialDaysLeft: 0, locked: true, hasStripeCustomer: false },
      expectLocked: true, expectUpgrade: true, expectManage: false,
    },
  ];

  for (const s of scenarios) {
    await page.evaluate((user) => {
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user } }),
      };
    }, s.user);
    await page.evaluate(() => window.renderSubscriptionSection && window.renderSubscriptionSection());
    await page.waitForTimeout(150);
    const html = await page.locator('#subscription-body').innerHTML();
    const bannerVisible = await page.locator('#subscription-body div[style*="overdue"]').count();
    assert((bannerVisible > 0) === s.expectLocked, `[${s.name}] locked banner visibility, expected ${s.expectLocked}`);
    const upgradeBtnCount = await page.locator('#subscription-body button:has-text("อัปเกรดเป็น Pro")').count();
    assert((upgradeBtnCount > 0) === s.expectUpgrade, `[${s.name}] upgrade button visibility, expected ${s.expectUpgrade}, html: ${html.slice(0,300)}`);
    const manageBtnCount = await page.locator('#subscription-body button:has-text("จัดการการเรียกเก็บเงิน")').count();
    assert((manageBtnCount > 0) === s.expectManage, `[${s.name}] manage billing button visibility, expected ${s.expectManage}`);
  }

  // No-account (cloud backup not enabled) case shows the hint, no crash
  await page.evaluate(() => {
    window.SidekickBackend = { isEnabled: () => false };
  });
  await page.evaluate(() => window.renderSubscriptionSection && window.renderSubscriptionSection());
  await page.waitForTimeout(150);
  const hintText = await page.locator('#subscription-body').textContent();
  assert(hintText && hintText.includes('15 วัน'), 'shows the "enable cloud backup to start trial" hint when no backend account, got: ' + hintText);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
