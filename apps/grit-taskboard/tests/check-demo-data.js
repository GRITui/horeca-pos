const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

  // ── Smoke pass: every persona seeds cleanly with zero console errors ──
  const PERSONAS = ['trainer', 'realestate', 'laundry', 'insurance', 'garage'];
  for (let i = 0; i < PERSONAS.length; i++) {
    const persona = PERSONAS[i];
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(String(err)));

    // The "Try a demo" login button is gone (2026-07-17) — the demo now
    // enters via the dedicated /demo URL, which redirects to login.html?demo=1.
    await page.goto('http://localhost:8923/login.html?demo=1');
    await page.waitForTimeout(300);
    await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.click(`#modal-persona-onboard .list-row:nth-child(${i + 1})`);
    await page.waitForTimeout(700);

    const toastText = await page.locator('#toast').textContent().catch(() => '');
    assert(toastText && toastText.includes('ตัวอย่าง'), `[${persona}] demo-seeded toast shown, got: ${toastText}`);

    const heroAmt = await page.locator('#hero-amt').textContent().catch(() => '');
    assert(heroAmt && heroAmt !== '฿0', `[${persona}] Home hero amount is non-zero after seeding, got: ${heroAmt}`);

    assert(errors.length === 0, `[${persona}] zero console errors, got: ${errors.join('; ')}`);
    await context.close();
  }

  // ── Deep pass: garage persona (heaviest nested data — vehicles/serviceHistory) ──
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html?demo=1');
  await page.waitForTimeout(300);
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#modal-persona-onboard .list-row:nth-child(5)'); // garage
  await page.waitForTimeout(700);

  // Clients screen: 5 seeded clients.
  await page.evaluate(() => window.switchScreen && window.switchScreen('customers'));
  await page.waitForTimeout(300);
  const clientRowCount = await page.locator('#customers-body .list-row').count();
  assert(clientRowCount === 5, 'garage: 5 demo clients listed, got ' + clientRowCount);

  // Open the first client, confirm vehicle plate + service history render (persona tracker).
  await page.locator('#customers-body .list-row').first().click();
  await page.waitForTimeout(300);
  // Plate/mileage/next-service-date render as <input value="..."> — check
  // innerHTML, not textContent (which never includes input field values).
  // Client list is name-sorted, not insertion order, so don't assume which
  // demo client landed first — just confirm A real seeded plate shows up.
  const GARAGE_PLATES = ['กข 1234', '1กค 5678', 'ทข 9012', '2กง 3456', '3กจ 7890'];
  const trackerHtml = await page.locator('#cust-persona-body').innerHTML().catch(() => '');
  assert(trackerHtml && GARAGE_PLATES.some(p => trackerHtml.includes(p)), 'garage: a real seeded vehicle plate renders in the persona tracker, got: ' + (trackerHtml || '').slice(0, 300));
  await page.evaluate(() => window.closeCustomerModal && window.closeCustomerModal());
  await page.waitForTimeout(200);

  // Pipeline: jobs across multiple stages present.
  await page.evaluate(() => window.switchScreen && window.switchScreen('pipeline'));
  await page.waitForTimeout(300);
  const pipelineText = await page.locator('#pipeline-body').textContent().catch(() => '');
  assert(pipelineText && pipelineText.length > 0, 'garage: pipeline board has content');

  // Invoices: 3 seeded.
  await page.evaluate(() => window.switchScreen && window.switchScreen('invoices'));
  await page.waitForTimeout(300);
  const invoiceRows = await page.locator('#invoices-body .list-row').count().catch(() => 0);
  assert(invoiceRows === 3, 'garage: 3 demo invoices listed, got ' + invoiceRows);

  // Re-running the demo (guest data already exists) prompts a confirm, and
  // accepting wipes + reseeds rather than duplicating on top. startDemo()
  // navigates to './' (index.html again, same directory) once it's done
  // wiping — not back to login.html.
  page.once('dialog', d => d.accept());
  await page.evaluate(() => window.startDemo && window.startDemo());
  let onboardVisibleAgain = false;
  try {
    await page.locator('#modal-persona-onboard.open').waitFor({ state: 'visible', timeout: 8000 });
    onboardVisibleAgain = true;
  } catch { /* handled by the assert below */ }
  assert(onboardVisibleAgain, 'garage: re-running the demo wipes old data and re-shows the persona picker');
  await page.click('#modal-persona-onboard .list-row:nth-child(5)');
  await page.waitForTimeout(700);
  const jobsAfter = await page.evaluate(async () => (await window.dbAll('jobs')).length);
  assert(jobsAfter === 6, 'garage: exactly 6 jobs after re-seeding (no duplication from the old run), got ' + jobsAfter);

  assert(errors.length === 0, 'zero console errors across the whole deep pass, got: ' + errors.join('; '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await context.close();
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
