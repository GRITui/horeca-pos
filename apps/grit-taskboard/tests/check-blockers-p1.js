// Sidekick — blocker/P1 batch (2026-07-16): restore id-remap, honest
// earned-this-month, invoice-paid reverse hook, dated-step reschedule +
// delete cleanup, stage-gate opt-out, booking-requests UI.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('dialog', d => d.accept());   // restore-confirm + any confirms in this suite

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'blk-test-' + Date.now());
  await page.fill('#auth-name', 'Blk Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // ═══ 1. Restore id-remap roundtrip ═══════════════════════════════════
  const remapResult = await page.evaluate(async () => {
    const uid = currentUser.id;
    // Seed a wired-together graph with DELIBERATELY conflicting old ids:
    // build the backup JSON by hand with high fake ids so a correct import
    // MUST remap (simply preserving them can't work — rows get re-minted).
    const backup = {
      app: 'Sidekick', version: APP_VERSION, exportedAt: nowISO(), user: 'x', settings: {},
      clients: [{ id: 901, uid, name: 'Remap Client', cuid: 'c-rm-1', createdAt: nowISO() }],
      services: [{ id: 902, uid, name: 'Remap Svc', rate: 100, cuid: 's-rm-1', updatedAt: nowISO() }],
      invoices: [{ id: 903, uid, number: 'INV-R1', clientId: 901, status: 'sent', cuid: 'i-rm-1', lineItems: [], updatedAt: nowISO() }],
      documents: [], packages: [], bookings: [], portfolio: [], research: [], expenses: [], progressLogs: [],
      jobs: [{ id: 904, uid, date: todayISO(), client: 'Remap Client', clientId: 901, serviceId: 902,
        serviceName: 'Remap Svc', amount: 500, cuid: 'j-rm-1', stageOrder: getStageOrder().slice(),
        stage: 'invoice', complete: false, invoiceId: 903, quoteDocId: null, packageId: null,
        milestones: [{ id: 'm1', pct: 50, amount: 250, invoiceId: 903 }], updatedAt: nowISO() }],
      followups: [{ id: 905, uid, key: 'overdue:901:903', dismissed: false, cuid: 'f-rm-1', updatedAt: nowISO() }],
    };
    // Feed importBackup via a synthetic file input.
    const file = new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.createElement('input'); inp.type = 'file'; inp.files = dt.files;
    await importBackup(inp);
    await new Promise(r => setTimeout(r, 300));
    const j = jobs.find(x => x.cuid === 'j-rm-1');
    const c = customers.find(x => x.cuid === 'c-rm-1');
    const svc = services.find(x => x.cuid === 's-rm-1');
    const inv = (await dbAll('invoices')).find(x => x.cuid === 'i-rm-1');
    const fu = (await dbAll('followups')).find(x => x.cuid === 'f-rm-1');
    return {
      ok: !!(j && c && svc && inv && fu),
      clientLink: j && c && j.clientId === c.id,
      serviceLink: j && svc && j.serviceId === svc.id,
      invoiceLink: j && inv && j.invoiceId === inv.id,
      milestoneLink: j && inv && j.milestones[0].invoiceId === inv.id,
      invClientLink: inv && c && inv.clientId === c.id,
      followupKey: fu && c && inv && fu.key === `overdue:${c.id}:${inv.id}`,
      oldIdsNotReused: j && j.clientId !== 901 || (c && c.id !== 901),
    };
  });
  assert(remapResult.ok, '1: all restored rows present');
  assert(remapResult.clientLink, '1: jobs.clientId remapped to the re-minted client id');
  assert(remapResult.serviceLink, '1: jobs.serviceId remapped');
  assert(remapResult.invoiceLink, '1: jobs.invoiceId remapped');
  assert(remapResult.milestoneLink, '1: milestone.invoiceId remapped');
  assert(remapResult.invClientLink, '1: invoices.clientId remapped');
  assert(remapResult.followupKey, '1: followup embedded-id key rewritten');

  // ═══ 2. Earned this month: paid+ stages only, lost excluded ═══════════
  const earned = await page.evaluate(async () => {
    const uid = currentUser.id;
    const mk = (stage, amount, extra) => dbPut('jobs', Object.assign({ uid, date: todayISO(), client: 'E', clientId: null,
      serviceId: null, serviceName: 'E', amount, tip: 0, expense: 0, count: 1, notes: '', netAmount: amount,
      cuid: cuid(), stageOrder: getStageOrder().slice(), stage, complete: false, invoiceId: null,
      quoteDocId: null, packageId: null, updatedAt: nowISO() }, extra || {}));
    await mk('pitch', 1000);                                    // not earned
    await mk('paid', 200);                                      // earned
    await mk('quote', 400, { complete: true, outcome: 'lost' }); // lost pre-paid: not earned
    await mk('delivery', 300);                                  // earned (past paid)
    await reload();
    renderHome();
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('hero-amt').textContent;
  });
  const digits = earned.replace(/[^0-9]/g, '');
  assert(digits === '1000' || digits === '500', '2: hero counts only paid+ jobs — expected ฿500 (+฿500 from remap job at invoice stage? no) got: ' + earned);
  // Precise check: 200 + 300 = 500 (the remap job sits at 'invoice' stage → excluded)
  assert(digits === '500', '2: hero-amt is exactly ฿500 (paid 200 + delivery 300; pitch/lost/invoice-stage excluded), got ' + earned);

  // ═══ 3. Invoice-marked-paid advances the linked job ═══════════════════
  const rev = await page.evaluate(async () => {
    const uid = currentUser.id;
    const invId = await dbAdd('invoices', { uid, number: 'INV-RH', clientId: null, status: 'sent', cuid: cuid(), lineItems: [], updatedAt: nowISO() });
    const jId = await dbPut('jobs', { uid, date: todayISO(), client: 'RH', clientId: null, serviceId: null,
      serviceName: 'RH', amount: 100, tip: 0, expense: 0, count: 1, notes: '', netAmount: 100, cuid: cuid(),
      stageOrder: getStageOrder().slice(), stage: 'paid', complete: false, invoiceId: invId, quoteDocId: null,
      packageId: null, updatedAt: nowISO() });
    await reload();
    await window.onInvoiceMarkedPaid(invId);
    await new Promise(r => setTimeout(r, 300));
    const j = jobs.find(x => x.id === jId);
    const modalOpen = !!document.getElementById('modal-appt');
    if (modalOpen) closeApptModal();
    return { stage: jobStage(j), gated: !!j.pendingGateStage || modalOpen };
  });
  assert(rev.stage === 'delivery', '3: job advanced paid → delivery via the reverse hook, got ' + rev.stage);
  assert(rev.gated, '3: the stage-gate fired after the hook-driven advance');

  // ═══ 4. Reschedule (✎) + delete cleanup ════════════════════════════════
  const resched = await page.evaluate(async () => {
    const uid = currentUser.id;
    const jId = await dbPut('jobs', { uid, date: todayISO(), client: 'RS', clientId: null, serviceId: null,
      serviceName: 'RS', amount: 100, tip: 0, expense: 0, count: 1, notes: '', netAmount: 100, cuid: cuid(),
      stageOrder: getStageOrder().slice(), stage: 'pitch', complete: false, invoiceId: null, quoteDocId: null,
      packageId: null, subTasks: [], updatedAt: nowISO() });
    await reload();
    const j = jobs.find(x => x.id === jId);
    const st = { id: cuid(), text: 'Site visit', done: false, dateType: 'exact', date: todayISO(),
      startTime: '10:00', bookingCuid: null, stage: null, repeatOfId: null };
    j.subTasks.push(st);
    await createBookingForStep(j, st);
    await dbPut('jobs', j);
    await reload();
    return { jId, stId: st.id, bookingCuid: st.bookingCuid };
  });
  await page.evaluate(({ jId, stId }) => { openEditJob(jId); }, resched);
  await page.waitForTimeout(300);
  const editBtn = await page.locator(`button[onclick*="editSubTask(${resched.jId}"]`).count();
  assert(editBtn === 1, '4: ✎ edit button renders on the dated step');
  await page.evaluate(({ jId, stId }) => editSubTask(jId, stId), resched);
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  const prefilledDate = await page.inputValue('#ap-date');
  assert(prefilledDate.length === 10, '4: edit mode prefills the current date, got ' + prefilledDate);
  const newDate = await page.evaluate(() => tlAddDays(todayISO(), 7));
  await page.fill('#ap-date', newDate);
  await page.fill('#ap-time', '14:30');
  await page.click('#ap-save');
  await page.waitForTimeout(400);
  const afterEdit = await page.evaluate(async ({ jId, stId, bookingCuid }) => {
    const j = jobs.find(x => x.id === jId);
    const st = j.subTasks.find(s => s.id === stId);
    const bk = (await dbAll('bookings')).find(b => b.cuid === bookingCuid);
    return { stDate: st.date, stTime: st.startTime, bkDate: bk && bk.date, bkTime: bk && bk.startTime, subCount: j.subTasks.length };
  }, resched);
  assert(afterEdit.subCount === 1, '4: edit mutated in place — no duplicate step');
  assert(afterEdit.stDate === newDate && afterEdit.stTime === '14:30', '4: step date/time updated');
  assert(afterEdit.bkDate === newDate && afterEdit.bkTime === '14:30', '4: linked calendar booking moved in the same write');
  await page.evaluate(({ jId, stId }) => deleteSubTask(jId, stId), resched);
  await page.waitForTimeout(300);
  const bkGone = await page.evaluate(async ({ bookingCuid }) =>
    !(await dbAll('bookings')).some(b => b.cuid === bookingCuid), resched);
  assert(bkGone, '4: deleting the step deletes its linked booking (no ghost appointments)');
  await page.evaluate(() => closeJobModal());   // section 6 clicks need the page uncovered

  // ═══ 5. Stage-gate opt-out ═════════════════════════════════════════════
  const gateOff = await page.evaluate(async () => {
    await saveSetting('stageGateOff', true);
    const uid = currentUser.id;
    const jId = await dbPut('jobs', { uid, date: todayISO(), client: 'G', clientId: null, serviceId: null,
      serviceName: 'G', amount: 1, tip: 0, expense: 0, count: 1, notes: '', netAmount: 1, cuid: cuid(),
      stageOrder: getStageOrder().slice(), stage: 'pitch', complete: false, invoiceId: null, quoteDocId: null,
      packageId: null, updatedAt: nowISO() });
    await reload();
    await advanceJobStage(jId);
    await new Promise(r => setTimeout(r, 200));
    const j = jobs.find(x => x.id === jId);
    const off = { stage: jobStage(j), pending: j.pendingGateStage, modal: !!document.getElementById('modal-appt') };
    await saveSetting('stageGateOff', false);
    await advanceJobStage(jId);
    await new Promise(r => setTimeout(r, 200));
    const j2 = jobs.find(x => x.id === jId);
    const on = { pending: j2.pendingGateStage, modal: !!document.getElementById('modal-appt') };
    if (on.modal) resolveApptNone();
    return { off, on };
  });
  assert(gateOff.off.stage === 'quote' && !gateOff.off.pending && !gateOff.off.modal, '5: gate off → card advances silently, no flag, no modal');
  assert(gateOff.on.pending && gateOff.on.modal, '5: gate back on → advancing gates again');

  // ═══ 6. Booking-requests UI against the stubbed contract ═══════════════
  await page.exposeFunction('__fakeReqList', () => ({ rows: [
    { id: 71, slotId: 5, clientName: 'K. Somchai', serviceName: 'PT session', startsAt: '2026-08-01T03:00:00Z', endsAt: '2026-08-01T04:00:00Z', holdExpired: false, createdAt: nowISOStub() },
    { id: 72, slotId: 6, clientName: 'K. Nok', serviceName: null, startsAt: '2026-08-02T03:00:00Z', endsAt: '2026-08-02T04:00:00Z', holdExpired: true, createdAt: nowISOStub() },
  ] }));
  function nowISOStub() { return new Date().toISOString(); }
  await page.evaluate(() => {
    window.__resolved = [];
    const base = window.SidekickBackend || {};
    window.SidekickBackend = Object.assign({}, base, {
      isEnabled: () => true,
      bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
      bookingRequestsList: async () => ({ ok: true, data: await window.__fakeReqList() }),
      bookingRequestResolve: async (id, action) => { window.__resolved.push([id, action]); return { ok: true, data: { ok: true, status: action === 'confirm' ? 'confirmed' : 'declined' } }; },
    });
  });
  await page.evaluate(() => switchScreen('more'));   // the section lives on the More screen — clicks need it visible
  await page.waitForTimeout(300);
  await page.evaluate(() => renderBookingSlotsSection());
  await page.waitForTimeout(300);
  const reqRows = await page.locator('#booking-requests-body .list-row').count();
  assert(reqRows === 2, '6: two pending requests render, got ' + reqRows);
  const expiredHint = await page.locator('#booking-requests-body').textContent();
  assert(expiredHint.includes('K. Somchai') && expiredHint.includes('PT session'), '6: request rows show client + service');
  await page.locator('#booking-requests-body .list-row').first().locator('button').first().click();
  await page.waitForTimeout(300);
  const resolved = await page.evaluate(() => window.__resolved);
  assert(resolved.length === 1 && resolved[0][0] === 71 && resolved[0][1] === 'confirm', '6: Confirm calls the API with the right booking id/action, got ' + JSON.stringify(resolved));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
