// Sidekick — cloud restore / team read cutover (2026-07-16): pullAll() +
// restoreFromCloud() close both the "cloud restore path" and "Team read
// cutover" backlog items with one mechanism — a team member's GET already
// resolves to the org owner's rows (lib/teams.js resolveDataOwner), so
// "restore this device" and "load your team's data" are the exact same
// client-side call, just labeled differently. This suite stubs
// SidekickBackend.pullAll() directly (dataClient.js's own reverse-map
// fidelity isn't exercised here — that's the server-shaped fetch layer;
// this tests restoreFromCloud()/importDataset()'s consumption of whatever
// pullAll() hands back) with an id-remap fixture shaped exactly like
// check-blockers-p1.js's section 1, to prove importDataset() still works
// correctly after being extracted out of importBackup().
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('dialog', d => d.accept());   // restore_cloud_confirm + any other confirms in this suite

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'cloud-restore-test-' + Date.now());
  await page.fill('#auth-name', 'Cloud Restore Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // A local expense predating the restore — used below to prove
  // importDataset() leaves the 'expenses' store alone when byStore doesn't
  // carry that key at all (pullAll() never fetches it — no server table).
  const preExistingExpenseId = await page.evaluate(async () => {
    const uid = currentUser.id;
    return dbAdd('expenses', { uid, date: todayISO(), amount: 42, notes: 'pre-restore expense', updatedAt: nowISO() });
  });

  // The canned dataset restoreFromCloud() will receive from the stubbed
  // pullAll() — same wired-together, deliberately-conflicting-id graph as
  // check-blockers-p1.js's section 1 (client 901 <- job.clientId 901,
  // invoice 903 <- job.invoiceId 903, followup 'overdue:901:903'), so a
  // correct import MUST remap rather than reuse the ids verbatim.
  const settingsRows = [
    { key: 'sellerBusinessName', value: 'Cloud Biz Name', updated_at: '2026-07-16T00:00:00.000Z' },
    { key: 'lang', value: 'en', updated_at: '2026-07-16T00:00:00.000Z' },
  ];
  async function setPullAllStub(sessionUser) {
    await page.evaluate(({ sessionUser }) => {
      const noop = async () => ({ ok: true, data: {} });
      const stageOrder = getStageOrder().slice();
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: sessionUser } }),
        billingCheckout: async () => ({ ok: false }), billingPortal: async () => ({ ok: false }),
        mirrorClientSave: noop, mirrorClientDelete: noop, mirrorJobSave: noop, mirrorJobDelete: noop,
        mirrorServiceSave: noop, mirrorServiceDelete: noop, mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
        mirrorDocumentSave: noop, mirrorDocumentDelete: noop, mirrorBookingSave: noop, mirrorBookingDelete: noop,
        mirrorFollowupSave: noop, mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
        mirrorResearchSave: noop, mirrorResearchDelete: noop, mirrorPackageSave: noop,
        mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop, mirrorSettingSave: noop,
        lineChannelStatus: async () => ({ ok: true, data: { connected: false, webhookUrl: 'https://x/api/line-webhook', bookingPageUrl: 'https://x/book.html' } }),
        bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestResolve: async () => ({ ok: true, data: {} }),
        teamMembersList: async () => ({ ok: true, data: { owner: { cuid: 'o1', name: 'Owner' }, myRole: (sessionUser.team && sessionUser.team.role) || 'owner', members: [] } }),
        pullAll: async () => ({
          ok: true,
          byStore: {
            clients: [{ id: 901, name: 'Cloud Client', cuid: 'cc-901', updatedAt: nowISOStub() }],
            services: [{ id: 902, name: 'Cloud Svc', rate: 100, cuid: 'cs-902', updatedAt: nowISOStub() }],
            invoices: [{ id: 903, number: 'INV-C1', clientId: 901, status: 'sent', cuid: 'ci-903', lineItems: [], updatedAt: nowISOStub() }],
            documents: [], packages: [], bookings: [], portfolio: [], research: [], progressLogs: [],
            jobs: [{ id: 904, date: todayISO(), client: 'Cloud Client', clientId: 901, serviceId: 902,
              serviceName: 'Cloud Svc', amount: 500, cuid: 'cj-904', stageOrder, stage: 'invoice',
              complete: false, invoiceId: 903, quoteDocId: null, packageId: null,
              milestones: [{ id: 'm1', pct: 50, amount: 250, invoiceId: 903 }], updatedAt: nowISOStub() }],
            followups: [{ id: 905, key: 'overdue:901:903', dismissed: false, cuid: 'cf-905', updatedAt: nowISOStub() }],
          },
          settingsRows: window.__settingsRowsStub,
          failed: [],
        }),
      };
      function nowISOStub() { return new Date().toISOString(); }
    }, { sessionUser });
    await page.evaluate((rows) => { window.__settingsRowsStub = rows; }, settingsRows);
    // Re-run with __settingsRowsStub now defined (pullAll's closure reads it
    // at call time, not definition time, so the ordering above is fine —
    // this second call just also refreshes __entitlements for the label test).
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.waitForTimeout(100);
  }

  const soloUser = {
    plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: true, clientCap: null, team: null,
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };
  const staffUser = {
    plan: 'team', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: false, clientCap: null,
    team: { role: 'staff', isOwner: false, orgOwnerName: 'Owner' },
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };

  // ── 1. Restore button renders when isEnabled()=true, plain label ──────
  await setPullAllStub(soloUser);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const restoreBtnCount = await page.locator('button[onclick="restoreFromCloud()"]').count();
  assert(restoreBtnCount === 1, '1: Restore button renders in Settings when isEnabled()=true');
  const restoreBtnLabel = await page.locator('button[onclick="restoreFromCloud()"]').textContent();
  assert(restoreBtnLabel.trim().length > 0 && !/team/i.test(restoreBtnLabel), '1: solo/owner account gets the plain restore label, got: ' + restoreBtnLabel);

  // ── 2. Team staff (not owner): button relabeled team_load_data ────────
  await setPullAllStub(staffUser);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const staffLabel = await page.locator('button[onclick="restoreFromCloud()"]').textContent();
  const expectedTeamLabel = await page.evaluate(() => t('team_load_data'));
  assert(staffLabel.trim() === expectedTeamLabel, '2: team staff sees the team_load_data label, got: ' + staffLabel + ' expected: ' + expectedTeamLabel);

  // ── 3. restoreFromCloud() end to end: remap, settings, toast ──────────
  const beforeLang = await page.evaluate(() => settings.lang);
  const result = await page.evaluate(async () => {
    await window.restoreFromCloud();
    await new Promise(r => setTimeout(r, 300));
    const j = jobs.find(x => x.cuid === 'cj-904');
    const c = customers.find(x => x.cuid === 'cc-901');
    const svc = services.find(x => x.cuid === 'cs-902');
    const inv = (await dbAll('invoices')).find(x => x.cuid === 'ci-903');
    const fu = (await dbAll('followups')).find(x => x.cuid === 'cf-905');
    return {
      ok: !!(j && c && svc && inv && fu),
      clientLink: j && c && j.clientId === c.id,
      serviceLink: j && svc && j.serviceId === svc.id,
      invoiceLink: j && inv && j.invoiceId === inv.id,
      milestoneLink: j && inv && j.milestones[0].invoiceId === inv.id,
      invClientLink: inv && c && inv.clientId === c.id,
      followupKey: fu && c && inv && fu.key === `overdue:${c.id}:${inv.id}`,
      oldIdsNotReused: (j && j.clientId !== 901) || (c && c.id !== 901),
      sellerBusinessName: settings.sellerBusinessName,
      langAfter: settings.lang,
    };
  });
  assert(result.ok, '3: all restored rows present after restoreFromCloud()');
  assert(result.clientLink, '3: jobs.clientId remapped to the re-minted client id (compared via cuid lookup)');
  assert(result.serviceLink, '3: jobs.serviceId remapped');
  assert(result.invoiceLink, '3: jobs.invoiceId remapped');
  assert(result.milestoneLink, '3: milestone.invoiceId remapped');
  assert(result.invClientLink, '3: invoices.clientId remapped');
  assert(result.followupKey, '3: followup embedded-id key rewritten, got: ' + JSON.stringify(result));
  assert(result.oldIdsNotReused, '3: re-minted ids are not the stale 901 (dbAdd always mints fresh ids)');
  assert(result.sellerBusinessName === 'Cloud Biz Name', '3: ordinary setting applied from settingsRows, got: ' + result.sellerBusinessName);
  assert(result.langAfter === beforeLang, '3: lang setting was skipped (device-local, never overwritten by a cloud pull), before=' + beforeLang + ' after=' + result.langAfter);

  const toastText = await page.locator('#toast').textContent();
  assert(toastText && toastText.trim().length > 0, '3: toast fired after restoreFromCloud() completed, got: ' + toastText);

  // ── 4. 'expenses' has no server resource — must survive untouched ─────
  const expenseStillThere = await page.evaluate(async (id) => {
    const row = await dbGet('expenses', id);
    return !!row;
  }, preExistingExpenseId);
  assert(expenseStillThere, "4: pre-existing local expense survives a cloud restore (byStore has no 'expenses' key at all)");

  // ── 5. Pass A.2: the REAL pullAll() shape — no `id` field at all (server
  // rows never carry one, see fromClientRow()'s comment in dataClient.js),
  // only __clientCuid/__invoiceCuid transient refs. Section 3 above uses a
  // synthetic id-remap fixture (same shape as check-blockers-p1.js's file-
  // backup test) to prove the oldId tier still works; this section proves
  // the cuid tier importDataset() now tries FIRST actually resolves links
  // when there is no id to fall back on. jobs.clientId/invoiceId are seeded
  // with deliberately-wrong foreign numbers (7777/8888, matching nothing in
  // this batch) alongside the correct __clientCuid/__invoiceCuid, so a pass
  // here can only mean the cuid tier fired — reusing the raw id by luck is
  // not possible when it's wrong on purpose.
  async function setPullAllStubCuidOnly(sessionUser) {
    await page.evaluate(({ sessionUser }) => {
      const noop = async () => ({ ok: true, data: {} });
      const stageOrder = getStageOrder().slice();
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: sessionUser } }),
        billingCheckout: async () => ({ ok: false }), billingPortal: async () => ({ ok: false }),
        mirrorClientSave: noop, mirrorClientDelete: noop, mirrorJobSave: noop, mirrorJobDelete: noop,
        mirrorServiceSave: noop, mirrorServiceDelete: noop, mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
        mirrorDocumentSave: noop, mirrorDocumentDelete: noop, mirrorBookingSave: noop, mirrorBookingDelete: noop,
        mirrorFollowupSave: noop, mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
        mirrorResearchSave: noop, mirrorResearchDelete: noop, mirrorPackageSave: noop,
        mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop, mirrorSettingSave: noop,
        lineChannelStatus: async () => ({ ok: true, data: { connected: false, webhookUrl: 'https://x/api/line-webhook', bookingPageUrl: 'https://x/book.html' } }),
        bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestsList: async () => ({ ok: true, data: { rows: [] } }),
        bookingRequestResolve: async () => ({ ok: true, data: {} }),
        teamMembersList: async () => ({ ok: true, data: { owner: { cuid: 'o1', name: 'Owner' }, myRole: (sessionUser.team && sessionUser.team.role) || 'owner', members: [] } }),
        pullAll: async () => ({
          ok: true,
          byStore: {
            clients: [{ name: 'Cuid-Only Client', cuid: 'cc2-901', updatedAt: nowISOStub() }],
            services: [], documents: [], packages: [], bookings: [], portfolio: [], research: [], progressLogs: [],
            invoices: [{ number: 'INV-C2', clientId: 7777, status: 'sent', cuid: 'ci2-903', lineItems: [],
              __clientCuid: 'cc2-901', updatedAt: nowISOStub() }],
            jobs: [{ date: todayISO(), client: 'Cuid-Only Client', clientId: 7777, serviceId: null,
              serviceName: null, amount: 500, cuid: 'cj2-904', stageOrder, stage: 'invoice', complete: false,
              invoiceId: 8888, quoteDocId: null, packageId: null,
              __clientCuid: 'cc2-901', __invoiceCuid: 'ci2-903', __serviceCuid: null,
              __quoteDocCuid: null, __packageCuid: null, updatedAt: nowISOStub() }],
            followups: [],
          },
          settingsRows: window.__settingsRowsStub,
          failed: [],
        }),
      };
      function nowISOStub() { return new Date().toISOString(); }
    }, { sessionUser });
    await page.evaluate((rows) => { window.__settingsRowsStub = rows; }, settingsRows);
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.waitForTimeout(100);
  }
  await setPullAllStubCuidOnly(soloUser);
  const cuidResult = await page.evaluate(async () => {
    await window.restoreFromCloud();
    await new Promise(r => setTimeout(r, 300));
    const j = jobs.find(x => x.cuid === 'cj2-904');
    const c = customers.find(x => x.cuid === 'cc2-901');
    const inv = (await dbAll('invoices')).find(x => x.cuid === 'ci2-903');
    return {
      ok: !!(j && c && inv),
      clientLink: j && c && j.clientId === c.id,
      invoiceLink: j && inv && j.invoiceId === inv.id,
      invClientLink: inv && c && inv.clientId === c.id,
      noStaleForeignId: j && j.clientId !== 7777 && j.invoiceId !== 8888,
      noTransientFields: j && !('__clientCuid' in j) && !('__invoiceCuid' in j) && !('__serviceCuid' in j)
        && !('__quoteDocCuid' in j) && !('__packageCuid' in j) && inv && !('__clientCuid' in inv),
    };
  });
  assert(cuidResult.ok, '5: all restored rows present after a cuid-only (no id fields) restoreFromCloud()');
  assert(cuidResult.clientLink, '5: jobs.clientId resolved purely via __clientCuid, no id field on the pulled row at all');
  assert(cuidResult.invoiceLink, '5: jobs.invoiceId resolved purely via __invoiceCuid');
  assert(cuidResult.invClientLink, '5: invoices.clientId resolved purely via __clientCuid');
  assert(cuidResult.noStaleForeignId, '5: the deliberately-wrong foreign clientId/invoiceId (7777/8888) was never reused');
  assert(cuidResult.noTransientFields, '5: __*Cuid transient fields stripped before dbAdd(), never persisted on the local record');
  const cuidToastText = await page.locator('#toast').textContent();
  assert(!/broken links/i.test(cuidToastText), '5: linksReset stayed 0 — no "broken links" reset phrase in the toast, got: ' + cuidToastText);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
