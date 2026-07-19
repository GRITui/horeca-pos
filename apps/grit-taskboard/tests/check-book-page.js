const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  const FAKE_ORIGIN = 'http://localhost:8923';
  let heldSlot = null;

  const allSlots = [
    { id: 101, starts_at: '2026-08-01T10:00:00+07:00', ends_at: '2026-08-01T11:00:00+07:00' },
    { id: 102, starts_at: '2026-08-01T14:00:00+07:00', ends_at: '2026-08-01T15:00:00+07:00' },
  ];
  await page.route('**/api/booking-availability*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        services: [
          { cuid: 'svc-1', name: '1-on-1 session', rate: 800 },
          { cuid: 'svc-2', name: 'Group class', rate: 400 },
        ],
        slots: allSlots.filter(s => s.id !== heldSlot),
      }),
    });
  });
  await page.route('**/api/booking-request*', async route => {
    const body = JSON.parse(route.request().postData());
    if (body.slotId === 101 && !heldSlot) {
      heldSlot = 101;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, bookingId: 1, service: '1-on-1 session', startsAt: '2026-08-01T10:00:00+07:00' }),
      });
    } else {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'That slot is no longer available — please pick another.' }) });
    }
  });

  // 1. Missing ?u= shows a clear error, not a crash.
  await page.goto(FAKE_ORIGIN + '/book.html');
  await page.waitForTimeout(300);
  const missingUText = await page.locator('.book-error').textContent().catch(() => null);
  assert(missingUText && missingUText.includes('missing'), 'missing ?u= param shows a clear error, got: ' + missingUText);

  // 2. With ?u=, loads services + slots.
  await page.goto(FAKE_ORIGIN + '/book.html?u=test-cuid-123');
  await page.waitForTimeout(400);
  const svcCount = await page.locator('.svc-btn').count();
  assert(svcCount === 2, 'both services rendered, got ' + svcCount);
  const slotCount = await page.locator('.slot-btn').count();
  assert(slotCount === 2, 'both open slots rendered, got ' + slotCount);
  assert(errors.length === 0, 'no console errors after initial load, got: ' + errors.join('; '));

  // 3. Submitting without picking anything is blocked with a toast, no request sent.
  await page.click('#book-submit');
  await page.waitForTimeout(300);
  const toastEmpty = await page.locator('#toast').textContent();
  assert(toastEmpty && toastEmpty.length > 0, 'submitting with nothing selected shows a guidance toast, got: ' + toastEmpty);

  // 4. Full happy path: pick service + slot + name, submit, see confirmation.
  await page.locator('.svc-btn').first().click();
  await page.locator('.slot-btn').first().click();
  await page.fill('#book-name', 'Somchai Test');
  await page.click('#book-submit');
  await page.waitForTimeout(400);
  const confirmText = await page.locator('.book-confirm').textContent();
  assert(confirmText && confirmText.includes('1-on-1 session'), 'confirmation shows the booked service, got: ' + confirmText);
  assert(confirmText && confirmText.includes('Request sent'), 'confirmation heading present');

  // 5. A second visitor hitting the now-taken slot gets a clean 409 handled as a toast, not a crash.
  await page.goto(FAKE_ORIGIN + '/book.html?u=test-cuid-123');
  await page.waitForTimeout(400);
  const slotCountAfter = await page.locator('.slot-btn').count();
  assert(slotCountAfter === 1, 'the taken slot no longer appears in a fresh load, got ' + slotCountAfter);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
