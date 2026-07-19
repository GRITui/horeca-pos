const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'opt-test-' + Date.now());
  await page.fill('#auth-name', 'Opt Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // Client + job factory (same in-page pattern as check-scheduling.js).
  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Opt Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Opt Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (serviceName, stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Opt Client', clientId: window.__cid,
        serviceId: null, serviceName, jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkJob = (name, stage, extra) =>
    page.evaluate(args => window.__mkJob(args[0], args[1], args[2]), [name, stage || null, extra || null]);
  const job = (id, expr) => page.evaluate(args => {
    const j = jobs.find(x => x.id === args[0]);
    return eval(args[1]);
  }, [id, expr]);

  // ═══ 1. Options section renders in the job edit modal ══════════════════
  const jobA = await mkJob('Condo search', 'pitch');
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  assert(await page.locator('#job-options-body').count() === 1, '1: options section present in edit modal');
  assert((await page.locator('#job-options-body .pkg-status').textContent()).length > 0, '1: empty state shown with no options');

  // ═══ 2. Add options ═════════════════════════════════════════════════════
  await page.fill('#job-option-new', 'Ashton Asoke');
  await page.press('#job-option-new', 'Enter');
  await page.waitForTimeout(200);
  await page.fill('#job-option-new', 'The Base Sukhumvit');
  await page.press('#job-option-new', 'Enter');
  await page.waitForTimeout(200);
  await page.fill('#job-option-new', 'Noble Around Ari');
  await page.press('#job-option-new', 'Enter');
  await page.waitForTimeout(200);
  assert(await job(jobA, '(j.options||[]).length') === 3, '2: three options persisted on the job');
  assert(await job(jobA, "j.options.every(o => o.status === 'considering')") === true, '2: new options start as considering');
  const optRows = await page.locator('#job-options-body .list-row').count();
  assert(optRows === 3, '2: three option rows rendered, got ' + optRows);

  // ═══ 3. Status select + rename persist ══════════════════════════════════
  await page.locator('#job-options-body .list-row').nth(1).locator('select').selectOption('interested');
  await page.waitForTimeout(200);
  assert(await job(jobA, "j.options[1].status") === 'interested', '3: status change persisted');
  const nameInput = page.locator('#job-options-body .list-row').nth(0).locator('input[type="text"]');
  await nameInput.fill('Ashton Asoke 2BR');
  await nameInput.blur();
  await page.waitForTimeout(200);
  assert(await job(jobA, "j.options[0].name") === 'Ashton Asoke 2BR', '3: rename persisted');

  // ═══ 4. Book-viewing hook: prefilled modal → dated step + booking + status flip ═
  await page.locator('#job-options-body .list-row').nth(0).locator('button[title]').click();
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  const prefill = await page.inputValue('#ap-step');
  assert(prefill.includes('Ashton Asoke 2BR'), '4: appointment modal prefilled with option name, got: ' + prefill);
  const futureDate = await page.evaluate(() => tlAddDays(todayISO(), 5));
  await page.fill('#ap-date', futureDate);
  await page.click('#ap-save');
  await page.waitForTimeout(400);
  assert(await job(jobA, "(j.subTasks||[]).some(s => s.dateType === 'exact' && s.bookingCuid)") === true, '4: exact dated step with booking link created');
  const bk = await page.evaluate(async (jid) => {
    const j = jobs.find(x => x.id === jid);
    const all = await dbAll('bookings');
    return all.some(b => b.jobCuid === j.cuid);
  }, jobA);
  assert(bk === true, '4: real booking row exists linked to the job');
  assert(await job(jobA, "j.options[0].status") === 'viewing', "4: option flipped considering → viewing in the same write");
  await page.locator('#job-options-body .list-row').nth(1).locator('button[title]').click();
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  await page.fill('#ap-date', futureDate);
  await page.click('#ap-save');
  await page.waitForTimeout(400);
  assert(await job(jobA, "j.options[1].status") === 'interested', "4: re-booking does NOT clobber an existing 'interested' verdict");

  // ═══ 5. Chosen auto-drops the others ════════════════════════════════════
  await page.locator('#job-options-body .list-row').nth(2).locator('select').selectOption('chosen');
  await page.waitForTimeout(300);
  assert(await job(jobA, "j.options[2].status") === 'chosen', '5: option marked chosen');
  assert(await job(jobA, "j.options[0].status === 'dropped' && j.options[1].status === 'dropped'") === true, '5: other live options auto-dropped');

  // ═══ 6. Card chip shows counts ══════════════════════════════════════════
  await page.evaluate(() => { document.querySelector('.modal-overlay.open .modal-close')?.click(); closeJobModal && closeJobModal(); });
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage(jobStage(jobs.find(j => j.id === id))); }, jobA);
  await page.waitForTimeout(300);
  const cardText = await page.locator('.kb-card').first().textContent();
  assert(/3/.test(cardText) && /1/.test(cardText), '6: card chip shows 3 options / 1 interested-or-chosen, got: ' + cardText.slice(0, 120));

  // ═══ 7. saveJob edit-preserve: options + subTasks survive a detail edit ══
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  await page.fill('#j-amount', '750');
  await page.evaluate(() => saveJob());
  await page.waitForTimeout(400);
  assert(await job(jobA, '(j.options||[]).length') === 3, '7: options survive an ordinary detail edit save');
  assert(await job(jobA, '(j.subTasks||[]).length') === 2, '7: sub-tasks survive the same edit save (regression fix)');
  assert(await job(jobA, 'j.amount') === 750, '7: the edit itself actually saved');

  // ═══ 8. Mark as lost (now a reason-picker modal, not a bare confirm()) ══
  const jobB = await mkJob('Dead deal', 'quote');
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage('quote'); }, jobB);
  await page.waitForTimeout(300);
  await page.evaluate(id => markJobLost(id), jobB);
  await page.waitForSelector('#modal-lost.open', { timeout: 5000 });
  await page.click('#lost-confirm');
  await page.waitForTimeout(400);
  assert(await job(jobB, "j.complete === true && j.outcome === 'lost'") === true, '8: lost sets complete + outcome lost');
  assert(await job(jobB, "jobStage(j)") === 'quote', '8: lost keeps the stage it died at');
  assert(await job(jobB, "j.pendingGateStage") === null, '8: lost clears any pending gate');
  const lostCard = await page.locator('.kb-card', { hasText: 'Dead deal' }).textContent();
  assert(/✗/.test(lostCard), '8: card shows the ✗ lost badge, got: ' + lostCard.slice(0, 100));

  // Cancelling the modal leaves the job untouched.
  const jobB2 = await mkJob('Alive deal', 'quote');
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('quote'); });
  await page.waitForTimeout(200);
  await page.evaluate(id => markJobLost(id), jobB2);
  await page.waitForSelector('#modal-lost.open', { timeout: 5000 });
  await page.click('#lost-cancel');
  await page.waitForTimeout(300);
  assert(await job(jobB2, "!j.complete && j.outcome == null") === true, '8: cancelling the modal leaves the deal live');

  // ═══ 9. Lost never counts as delivered (package deduction guard) ════════
  const pkgCheck = await page.evaluate(async () => {
    const pkgId = await dbAdd('packages', { uid: currentUser.id, cuid: cuid(), clientId: window.__cid,
      totalSessions: 5, price: 1000, purchasedDate: todayISO(), expiresAt: null, notes: '', createdAt: nowISO() });
    const jid = await window.__mkJob('Pkg lost deal', 'pitch', { packageId: pkgId });
    const j = jobs.find(x => x.id === jid);
    j.complete = true; j.outcome = 'lost';
    await dbPut('jobs', j);
    await reload();
    const pkg = packages.find(p => p.id === pkgId);
    return { used: packageUsed(pkg), remaining: packageRemaining(pkg) };
  });
  assert(pkgCheck.used === 0 && pkgCheck.remaining === 5, '9: a lost pitch-stage package job burns zero sessions, got ' + JSON.stringify(pkgCheck));

  // ═══ 10. Lost excluded from timeline; reopen via back ═══════════════════
  const tlCheck = await page.evaluate(async (jid) => {
    const j = jobs.find(x => x.id === jid);
    j.subTasks = [{ id: cuid(), text: 'viewing', done: false, dateType: 'exact', date: todayISO(), startTime: '10:00', bookingCuid: null, stage: null, repeatOfId: null }];
    await dbPut('jobs', j);
    await reload();
    setPipelineView('timeline');
    await new Promise(r => setTimeout(r, 300));
    const rowLabels = Array.from(document.querySelectorAll('.tl-label')).map(el => el.textContent);
    setPipelineView('board');
    return rowLabels;
  }, jobB);
  assert(!tlCheck.some(l => l.includes('Dead deal')), '10: lost job (dated step and all) absent from the timeline');
  await page.evaluate(id => moveJobStageBack(id), jobB);
  await page.waitForTimeout(300);
  assert(await job(jobB, "!j.complete && j.outcome == null") === true, '10: ← reopens a lost deal (outcome cleared)');

  // ═══ 11. Persona label: realestate gets "Buildings" wording ═════════════
  await page.evaluate(async () => { settings.businessType = 'realestate'; await saveSetting('businessType', 'realestate'); });
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  const reTitle = await page.locator('#job-options-title').textContent();
  const thaiRe = await page.evaluate(() => t('options_title_re'));
  assert(reTitle === thaiRe, '11: realestate persona swaps the section title, got: ' + reTitle);

  // ═══ 12. Legacy job (no options) renders without errors ═════════════════
  const legacy = await mkJob('Legacy job', 'pitch');
  await page.evaluate(id => openEditJob(id), legacy);
  await page.waitForTimeout(300);
  assert((await page.locator('#job-options-body .pkg-status').count()) === 1, '12: legacy job shows the options empty state, no crash');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
