// Sidekick — guest -> account data adoption (2026-07-17). Closes the P1
// "guest/demo -> account data adoption" gap: registering a real account on
// a device that already has guest data used to silently start empty, with
// export/restore as the only (undiscoverable) way to carry it over.
// maybeOfferGuestAdoption()/adoptGuestData() in app.js offer it automatically
// right after first-run persona onboarding.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('dialog', d => d.accept());

  // ═══ (a) Guest mode: seed 2 clients + 1 job (referencing a client by id)
  // + 1 setting, all under uid 'guest' ═══════════════════════════════════
  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('button.auth-btn.guest');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(400);

  const seeded = await page.evaluate(async () => {
    const c1 = await dbAdd('clients', { uid: 'guest', name: 'Guest Client One', cuid: cuid(), createdAt: nowISO() });
    const c2 = await dbAdd('clients', { uid: 'guest', name: 'Guest Client Two', cuid: cuid(), createdAt: nowISO() });
    const jobId = await dbAdd('jobs', {
      uid: 'guest', date: todayISO(), client: 'Guest Client One', clientId: c1,
      serviceId: null, serviceName: 'Guest Service', amount: 100, cuid: cuid(),
      stageOrder: getStageOrder().slice(), stage: 'lead', complete: false, updatedAt: nowISO(),
    });
    await saveSetting('crmNotes', 'a note from the guest session');
    // Expected total isn't just "2 clients + 1 job": finishAppBoot() already
    // auto-seeded this persona's default services under uid 'guest' too
    // (seedServicesIfEmpty(), 'services' is itself a BACKUP_STORES member),
    // so compute the real total the same way guestDataExists()/the modal do
    // rather than hardcoding a count that ignores those.
    const allByStore = await Promise.all(BACKUP_STORES.map(s => dbAll(s)));
    const expectedN = allByStore.reduce((sum, rows) => sum + rows.filter(r => r.uid === 'guest').length, 0);
    return { c1, c2, jobId, expectedN };
  });
  assert(seeded.c1 && seeded.c2 && seeded.jobId, 'seeded 2 guest clients + 1 guest job');

  // ═══ (b) Log out, register a fresh account, complete persona onboarding,
  // remove the cloud-backup modal if present ═════════════════════════════
  await page.evaluate(() => window.logout && window.logout());
  await page.waitForURL('**/login.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  const usernameA = 'adopt-test-a-' + Date.now();
  await page.fill('#auth-user', usernameA);
  await page.fill('#auth-name', 'Adopt Tester A');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // ═══ (c) Adoption modal appears with the right count (every BACKUP_STORES
  // row under uid 'guest' — the setting isn't part of that count) ═══════
  await page.waitForSelector('#guest-adopt-modal', { timeout: 5000 });
  const modalBody = await page.locator('#guest-adopt-modal .form-body').textContent();
  assert(modalBody.includes(String(seeded.expectedN)), `adoption modal body shows the row count (${seeded.expectedN}), got: ` + modalBody);

  const accountAId = await page.evaluate(() => currentUser.id);

  // ═══ (d) Adopt: rows move to the new uid with the SAME ids (job.clientId
  // still resolves), guest workspace empties out, toast fires ═══════════
  await page.click('#guest-adopt-modal-adopt');
  await page.waitForTimeout(400);

  const modalGone = await page.evaluate(() => !document.getElementById('guest-adopt-modal'));
  assert(modalGone, 'adoption modal closes after adopting');

  const toastText = await page.evaluate(() => {
    const el = document.getElementById('toast');
    return el && el.classList.contains('show') ? el.textContent : null;
  });
  assert(toastText && toastText.includes(String(seeded.expectedN)), 'adoption toast fired with the adopted count, got: ' + toastText);

  const after = await page.evaluate(async ({ c1, c2, jobId, accountAId }) => {
    const clientA = await dbGet('clients', c1);
    const clientB = await dbGet('clients', c2);
    const job = await dbGet('jobs', jobId);
    const stillGuestExists = await guestDataExists();
    const settingRow = (await dbAll('settings')).find(r => r.key === accountAId + ':crmNotes');
    return {
      clientAUid: clientA && clientA.uid, clientBUid: clientB && clientB.uid,
      jobUid: job && job.uid, jobClientId: job && job.clientId,
      stillGuestExists, settingAdopted: settingRow && settingRow.value,
    };
  }, { c1: seeded.c1, c2: seeded.c2, jobId: seeded.jobId, accountAId });

  assert(after.clientAUid === accountAId && after.clientBUid === accountAId, 'both clients now owned by the new account, same ids');
  assert(after.jobUid === accountAId, 'job now owned by the new account, same id');
  assert(after.jobClientId === seeded.c1, 'job.clientId still points at the SAME client id — zero remap');
  assert(after.stillGuestExists === false, 'guestDataExists() is false after adoption');
  assert(after.settingAdopted === 'a note from the guest session', 'guest-only setting copied onto the new account (account had no crmNotes of its own)');

  // ═══ (e) A second fresh account, on the same device, with no guest data
  // left -> no adoption offer ═════════════════════════════════════════════
  await page.evaluate(() => window.logout && window.logout());
  await page.waitForURL('**/login.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  const usernameB = 'adopt-test-b-' + Date.now();
  await page.fill('#auth-user', usernameB);
  await page.fill('#auth-name', 'Adopt Tester B');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.waitForTimeout(300);
  const noModalForB = await page.evaluate(() => !document.getElementById('guest-adopt-modal'));
  assert(noModalForB, 'a second fresh account with no guest data on the device gets no adoption offer');

  // ═══ (f) Seen-flag: create NEW guest data on this device, then log back
  // into the FIRST account (already offered once) -> still no second offer,
  // even though guestDataExists() is true again ══════════════════════════
  await page.evaluate(() => window.logout && window.logout());
  await page.waitForURL('**/login.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click('button.auth-btn.guest');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  // Fresh guest on this device now (no interstitial — the prior guest data
  // was moved out, not left behind) since businessType is already set from
  // account B's earlier onboarding... but guest is a separate uid with its
  // own settings, so seed data directly without relying on any persona gate.
  await page.evaluate(async () => {
    await dbAdd('clients', { uid: 'guest', name: 'Second Guest Client', cuid: cuid(), createdAt: nowISO() });
  });
  await page.evaluate(() => window.logout && window.logout());
  await page.waitForURL('**/login.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  // tab-login is the default active tab
  await page.fill('#auth-user', usernameA);
  await page.fill('#auth-pass', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const guestDataExistsNow = await page.evaluate(() => guestDataExists());
  assert(guestDataExistsNow === true, 'sanity: there IS new guest data on the device again at this point');
  const noSecondOfferForA = await page.evaluate(() => !document.getElementById('guest-adopt-modal'));
  assert(noSecondOfferForA, 'account A, already offered once, gets no second adoption offer even though guest data exists again');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
