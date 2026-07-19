const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const errors = [];
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('button.auth-btn.guest');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Choose "Other" (custom) persona this time
  const rows = page.locator('#modal-persona-onboard .list-row');
  await rows.nth(5).click(); // 6th row = custom/Other
  await page.waitForTimeout(500);

  const btVal = await page.evaluate(() => window.settings && window.settings.businessType);
  // settings isn't on window; read select instead after navigating to More
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const selectVal = await page.inputValue('#set-business-type');
  assert(selectVal === 'custom', 'chosen "Other" should set businessType=custom, got: ' + selectVal);

  // Toggle theme to dark via Settings, confirm it actually applies
  await page.selectOption('#set-theme', 'dark');
  await page.waitForTimeout(200);
  const themeAfterToggle = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeAfterToggle === 'dark', 'switching theme select to dark should apply dark, got: ' + themeAfterToggle);

  // Reload and confirm dark choice persisted (explicit user choice, not reset to light default)
  await page.reload();
  await page.waitForTimeout(600);
  const themeAfterReload = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeAfterReload === 'dark', 'explicit dark choice should persist across reload, got: ' + themeAfterReload);

  // Add a client and confirm the persona-tracker section is hidden for 'custom'
  await page.evaluate(() => window.switchScreen && window.switchScreen('customers'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.openAddCustomer && window.openAddCustomer());
  await page.waitForTimeout(200);
  await page.fill('#c-name', 'Test Client');
  await page.evaluate(() => window.saveCustomer && window.saveCustomer());
  await page.waitForTimeout(400);
  // open the newly created client
  await page.click('.list-row:has-text("Test Client")').catch(() => {});
  await page.waitForTimeout(300);
  const trackerDisplay = await page.evaluate(() => {
    const el = document.getElementById('cust-persona-section');
    return el ? getComputedStyle(el).display : null;
  });
  assert(trackerDisplay === 'none', 'persona tracker section should be hidden for custom persona, got: ' + trackerDisplay);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
