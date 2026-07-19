/* Sidekick — LINE booking confirm ⇄ local calendar (2026-07-17).
 *
 * Closes the recorded P2 "unify local Calendar bookings ↔ availability_slots":
 * before this pass, a LINE booking request the freelancer confirmed via
 * renderBookingRequestsSection()'s UI only ever lived server-side
 * (availability_slots/bookings) — it never showed up on their own calendar
 * (bookings.js's local 'bookings' store), so nothing stopped them from
 * double-booking that slot against their own pipeline work.
 *
 * v1 scope covered here: a confirmed LINE request materializes as a local
 * calendar booking, exactly once, with correct local-time date/time. NOT
 * covered (residual, by design): local calendar entries auto-blocking open
 * public slots, and slot-vs-booking conflict warnings.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node check-slot-calendar.js
 * Expects http://localhost:8923 serving ../app.
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  // Fixed to Asia/Bangkok so the UTC-vs-local-date test below is
  // deterministic regardless of the host machine's own timezone — the app's
  // local-time conversion (localDateTimeParts in app.js) uses whatever
  // timezone the browser itself is in, same as todayISO()/Date's plain
  // getters always have.
  const page = await browser.newPage({ timezoneId: 'Asia/Bangkok' });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'slotcal-test-' + Date.now());
  await page.fill('#auth-name', 'Slotcal Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // ── Build the two fixture rows around "today" (in the browser's Asia/
  // Bangkok clock) so the suite never hardcodes a calendar date that could
  // drift into the past. Row 501's startsAt is 20:00 UTC on today's UTC
  // date — 03:00 the NEXT day in Asia/Bangkok (+7h) — deliberately chosen so
  // the UTC date and the Bangkok local date disagree, exercising the
  // local-time conversion (not just a UTC slice) end to end. Ends 90
  // minutes later (04:30 Bangkok, next day).
  const fixture = await page.evaluate(() => {
    const today = todayISO();               // Asia/Bangkok "today" per the page's own clock
    const expectedDate = tlAddDays(today, 1); // the Bangkok-local date the booking should land on
    return {
      today,
      expectedDate,
      startsAt: `${today}T20:00:00Z`,
      endsAt: `${today}T21:30:00Z`,
    };
  });
  assert(fixture.expectedDate !== fixture.today, 'setup: fixture spans a UTC/Bangkok date boundary (expectedDate != UTC date), got ' + JSON.stringify(fixture));

  // ── Stub SidekickBackend: one row to confirm (id 501), one to decline
  // (id 502) — same stub shape as tests/check-blockers-p1.js §6, which
  // exercises the same requests UI this pass extends.
  await page.evaluate(({ startsAt, endsAt }) => {
    window.__resolved = [];
    const base = window.SidekickBackend || {};
    window.SidekickBackend = Object.assign({}, base, {
      isEnabled: () => true,
      bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
      bookingRequestsList: async () => ({ ok: true, data: { rows: [
        { id: 501, slotId: 41, clientName: 'Fon Testcase', serviceName: 'Massage 90min', startsAt, endsAt, holdExpired: false, createdAt: new Date().toISOString() },
        { id: 502, slotId: 42, clientName: 'Decline Client', serviceName: null, startsAt, endsAt, holdExpired: false, createdAt: new Date().toISOString() },
      ] } }),
      bookingRequestResolve: async (id, action) => {
        window.__resolved.push([id, action]);
        return { ok: true, data: { ok: true, status: action === 'confirm' ? 'confirmed' : 'declined' } };
      },
      // Stubbed so the fire-and-forget mirror call in
      // createLocalBookingFromLineRequest() never hits a real /api endpoint.
      mirrorBookingSave: async () => ({ ok: true }),
    });
  }, { startsAt: fixture.startsAt, endsAt: fixture.endsAt });

  await page.evaluate(() => switchScreen('more'));   // the section lives on the More screen — clicks need it visible
  await page.waitForTimeout(300);
  await page.evaluate(() => renderBookingSlotsSection());
  await page.waitForTimeout(300);

  const reqRows = await page.locator('#booking-requests-body .list-row').count();
  assert(reqRows === 2, 'setup: two pending requests render, got ' + reqRows);

  // ═══ 1. Confirm materializes exactly one local calendar booking ═══════
  await page.locator('#booking-requests-body .list-row').nth(0).locator('button').nth(0).click(); // row 0 = id 501, button 0 = Confirm
  await page.waitForTimeout(400);

  const afterFirstConfirm = await page.evaluate(async () => {
    const rows = (await dbAll('bookings')).filter(b => b.lineBookingId === 501);
    return rows.map(b => ({ date: b.date, startTime: b.startTime, durationMin: b.durationMin, title: b.title, status: b.status, lineBookingId: b.lineBookingId, customerId: b.customerId, jobCuid: b.jobCuid }));
  });
  assert(afterFirstConfirm.length === 1, '1: confirming creates exactly one local booking row, got ' + afterFirstConfirm.length);
  const row1 = afterFirstConfirm[0] || {};
  assert(row1.date === fixture.expectedDate, `1: booking date is the LOCAL (Bangkok) date ${fixture.expectedDate}, got ${row1.date}`);
  assert(row1.startTime === '03:00', '1: booking startTime is local 03:00 (20:00 UTC + 7h), got ' + row1.startTime);
  assert(row1.durationMin === 90, '1: durationMin derived from endsAt-startsAt = 90, got ' + row1.durationMin);
  assert(typeof row1.title === 'string' && row1.title.includes('Fon Testcase'), '1: title contains the client name, got ' + row1.title);
  assert(row1.lineBookingId === 501, '1: lineBookingId marker set for idempotence');
  assert(row1.status === 'scheduled', '1: booking status is scheduled, got ' + row1.status);

  // Locale-agnostic: the account's language (en/th, chosen at persona
  // onboarding) affects which string renders, so compare against the same
  // i18n key the app itself used rather than an English substring.
  const toastText = await page.locator('#toast').textContent();
  const expectedToast = await page.evaluate(() => t('booking_confirmed_calendar_toast'));
  assert(toastText === expectedToast, '1: confirm toast uses booking_confirmed_calendar_toast, got: ' + toastText);

  // ═══ 2. Re-render + a second resolve on the SAME id stays at ONE row ═══
  // renderBookingSlotsSection() re-runs at the end of resolveBookingRequest,
  // and the stub still lists id 501 as pending (nothing in this fake
  // contract removes it) — the same double-tap / re-render race a slow
  // network could produce for real.
  const reqRowsAfter = await page.locator('#booking-requests-body .list-row').count();
  assert(reqRowsAfter === 2, '2: stub still shows both rows after re-render (simulates the race), got ' + reqRowsAfter);
  await page.locator('#booking-requests-body .list-row').nth(0).locator('button').nth(0).click(); // confirm id 501 again
  await page.waitForTimeout(400);
  const afterSecondConfirm = await page.evaluate(async () =>
    (await dbAll('bookings')).filter(b => b.lineBookingId === 501).length);
  assert(afterSecondConfirm === 1, '2: a second confirm on the same request id still yields exactly ONE booking row, got ' + afterSecondConfirm);
  const resolvedCalls = await page.evaluate(() => window.__resolved);
  assert(resolvedCalls.filter(([id, action]) => id === 501 && action === 'confirm').length === 2,
    '2: resolveBookingRequest DID call the API both times (idempotence lives client-side, not by skipping the call), got ' + JSON.stringify(resolvedCalls));

  // ═══ 3. Decline creates no local booking ═══════════════════════════════
  await page.locator('#booking-requests-body .list-row').nth(1).locator('button').nth(1).click(); // row 1 = id 502, button 1 = Decline
  await page.waitForTimeout(400);
  const declinedRows = await page.evaluate(async () =>
    (await dbAll('bookings')).filter(b => b.lineBookingId === 502).length);
  assert(declinedRows === 0, '3: declining creates no local booking, got ' + declinedRows);
  const declineCall = await page.evaluate(() => window.__resolved.some(([id, action]) => id === 502 && action === 'decline'));
  assert(declineCall, '3: Decline still calls the resolve API with action=decline');

  // ═══ 4. The confirmed booking appears on the freelancer's own calendar ═
  await page.evaluate(() => switchScreen('book'));
  await page.waitForTimeout(500);
  // The target date may fall in the month after "today" (if "today" is the
  // last day of its month) — the month grid opens on the current month, so
  // step forward at most once to reach it.
  const monthsToAdvance = fixture.expectedDate.slice(0, 7) === fixture.today.slice(0, 7) ? 0 : 1;
  for (let i = 0; i < monthsToAdvance; i++) {
    await page.click('#cal-next');
    await page.waitForTimeout(300);
  }
  const dotCount = await page.locator(`.cal-cell[data-cal="${fixture.expectedDate}"] .cal-dot-book`).count();
  assert(dotCount > 0, `4: month calendar shows a booking dot on ${fixture.expectedDate}, got ${dotCount}`);
  await page.click(`.cal-cell[data-cal="${fixture.expectedDate}"]`);
  await page.waitForTimeout(300);
  const dayPanelText = await page.locator('.cal-daypanel').textContent().catch(() => '');
  assert(dayPanelText.includes('Fon Testcase'), '4: the day panel lists the confirmed booking by client name, got: ' + dayPanelText);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
