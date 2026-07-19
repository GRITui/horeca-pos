const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const errors = [];
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // Fresh guest boot via login.html
  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);

  // 1. Default theme should be light (no dark dataset)
  const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeAttr === 'light' || themeAttr === undefined, 'default theme should be light, got: ' + themeAttr);

  // 2. Default language should be Thai (tagline text, since HTML fallback is English until applyLang())
  await page.waitForTimeout(200);
  const tagline = await page.textContent('#s-auth .auth-hero p');
  assert(tagline && /[฀-๿]/.test(tagline), 'tagline should render in Thai by default, got: ' + tagline);
  const loginBtnText = await page.textContent('#tab-login');
  assert(loginBtnText && /[฀-๿]/.test(loginBtnText), 'login tab should render in Thai, got: ' + loginBtnText);

  // 3. Continue as guest -> should land on index.html and show the persona onboarding modal
  await page.click('button.auth-btn.guest');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  const modalOpen = await page.evaluate(() => document.getElementById('modal-persona-onboard').classList.contains('open'));
  assert(modalOpen, 'persona onboarding modal should be open on first run');

  const homeActive = await page.evaluate(() => document.getElementById('s-home').classList.contains('active'));
  assert(!homeActive, 'Home should NOT be active yet, onboarding should block boot');

  // Onboarding modal shows 6 choices
  const rowCount = await page.locator('#modal-persona-onboard .list-row').count();
  assert(rowCount === 6, 'onboarding should show 6 persona choices, got: ' + rowCount);

  // 4. Pick "garage" persona
  await page.click('#modal-persona-onboard .list-row:has-text("อู่ซ่อมรถ")').catch(async () => {
    // fallback to English label in case lang somehow reverted
    await page.click('#modal-persona-onboard .list-row:nth-child(5)');
  });
  await page.waitForTimeout(500);

  const modalClosed = await page.evaluate(() => !document.getElementById('modal-persona-onboard').classList.contains('open'));
  assert(modalClosed, 'onboarding modal should close after choosing a persona');

  const homeActive2 = await page.evaluate(() => document.getElementById('s-home').classList.contains('active'));
  assert(homeActive2, 'Home should be active after choosing a persona');

  const businessType = await page.evaluate(() => window.businessType ? window.businessType() : null);
  // businessType() isn't on window explicitly; read via settings select instead
  const btSelectVal = await page.inputValue('#set-business-type').catch(() => null);

  // 5. Verify services were auto-seeded for garage persona (Oil change / Full service)
  await page.click('.nav-btn:has-text("More"), .nav-btn').catch(() => {});
  // Navigate to Settings/More screen to check business type select value, and Services screen for seeded services
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const btVal = await page.inputValue('#set-business-type');
  assert(btVal === 'garage', 'Settings business-type select should reflect chosen persona (garage), got: ' + btVal);

  await page.evaluate(() => window.switchScreen && window.switchScreen('services'));
  await page.waitForTimeout(300);
  const servicesText = await page.textContent('#services-body');
  assert(servicesText && servicesText.includes('Oil change'), 'garage persona should auto-seed "Oil change" service, got: ' + (servicesText || '').slice(0, 200));

  // 6. Reload -> onboarding should NOT show again (already set)
  await page.reload();
  await page.waitForTimeout(600);
  const modalOpenAfterReload = await page.evaluate(() => document.getElementById('modal-persona-onboard').classList.contains('open'));
  assert(!modalOpenAfterReload, 'onboarding modal should not reappear after businessType is already set');
  const homeActiveAfterReload = await page.evaluate(() => document.getElementById('s-home').classList.contains('active'));
  assert(homeActiveAfterReload, 'Home should be active immediately on reload once persona is already chosen');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
