const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'team-test-' + Date.now());
  await page.fill('#auth-name', 'Team Test');
  await page.fill('#auth-pass', 'testpassword123');
  await page.fill('#auth-confirm', 'testpassword123');
  await page.click('#auth-submit');
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(400);
  await page.evaluate(() => { const m = document.getElementById('cloud-backup-modal'); if (m) m.remove(); });

  // Server-side fake state, mutated by the exposed functions below.
  let teamState = { members: [], myRole: 'owner', ownerName: 'Test Owner' };
  let lastCheckoutSeats = null;
  let lastInviteRole = null;
  let joinedToken = null;

  async function setEntitlements(user) {
    await page.evaluate((u) => {
      const noop = async () => ({ ok: true, data: {} });
      window.SidekickBackend = {
        isEnabled: () => true,
        session: async () => ({ ok: true, data: { user: u } }),
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
        // Fake server-side team state, driven from this test's own
        // Node-side closures below (set via window.__fakeTeam*).
        teamCheckout: async (seats) => ({ ok: true, data: await window.__fakeTeamCheckout(seats) }),
        teamInvite: async (role) => ({ ok: true, data: await window.__fakeTeamInvite(role) }),
        teamJoin: async (token) => ({ ok: true, data: await window.__fakeTeamJoin(token) }),
        teamMembersList: async () => ({ ok: true, data: await window.__fakeTeamMembersList() }),
        teamMemberRemove: async (memberCuid) => ({ ok: true, data: await window.__fakeTeamMemberRemove(memberCuid) }),
      };
    }, user);
    await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
    await page.waitForTimeout(100);
  }

  // Same-page hash fragment, not a real external URL — startTeamCheckout()
  // does `window.location.href = url`, and a real cross-origin URL would
  // navigate the browser away and destroy this test's execution context.
  await page.exposeFunction('__fakeTeamCheckout', (seats) => { lastCheckoutSeats = seats; return { url: '#team-checkout-test' }; });
  await page.exposeFunction('__fakeTeamInvite', (role) => {
    lastInviteRole = role;
    return { token: 'tok-' + role, inviteUrl: 'https://gritui.github.io/Sidekickz/login.html?teamInvite=tok-' + role };
  });
  await page.exposeFunction('__fakeTeamJoin', (token) => { joinedToken = token; return { joined: true }; });
  await page.exposeFunction('__fakeTeamMembersList', () => ({ owner: { cuid: 'owner-1', name: teamState.ownerName }, myRole: teamState.myRole, members: teamState.members }));
  await page.exposeFunction('__fakeTeamMemberRemove', (memberCuid) => {
    teamState.members = teamState.members.filter(m => m.cuid !== memberCuid);
    return { removed: true };
  });

  const basePro = {
    plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: true, clientCap: null, team: null,
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };
  const teamOwner = {
    plan: 'team', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: true, clientCap: null,
    team: { role: 'owner', isOwner: true, seats: 3, memberCount: 2 },
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };
  const teamAdmin = {
    plan: 'team', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: false, clientCap: null,
    team: { role: 'admin', isOwner: false, orgOwnerName: 'Test Owner' },
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };
  const teamStaff = {
    plan: 'team', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
    hasStripeCustomer: false, clientCap: null,
    team: { role: 'staff', isOwner: false, orgOwnerName: 'Test Owner' },
    features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  };

  // ── 1. Pro plan, not on a team: locked hint, no roster ────────────────
  await setEntitlements(basePro);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  const hintText = await page.locator('#team-body').textContent();
  assert(hintText && hintText.trim().length > 0, 'shows the Team-plan-needed hint on Pro with no team membership');
  assert((await page.locator('#team-body .list-card').count()) === 0, 'no roster card shown when not on a team');

  // ── 2. Team owner: seat usage, roster, both invite buttons ────────────
  teamState = { members: [
    { cuid: 'staff-1', name: 'Staff One', role: 'staff', joinedAt: '2026-07-01' },
    { cuid: 'admin-1', name: 'Admin One', role: 'admin', joinedAt: '2026-07-02' },
  ], myRole: 'owner', ownerName: 'Test Owner' };
  await setEntitlements(teamOwner);
  await page.evaluate(() => window.renderTeamSection && window.renderTeamSection());
  await page.waitForTimeout(300);
  const ownerTitle = await page.locator('#team-body .list-card').first().locator('.list-title').first().textContent();
  assert(ownerTitle.includes('Test Owner'), 'owner card shows the org owner name, got: ' + ownerTitle);
  const seatUsageText = await page.locator('#team-body .list-card').first().locator('.list-sub').first().textContent();
  assert((seatUsageText.match(/3/g) || []).length === 2, 'seat usage shows used/total as "3 ... 3", got: ' + seatUsageText);
  const memberRows = await page.locator('#team-body .list-card').nth(1).locator('.list-row').count();
  assert(memberRows === 2, 'two member rows rendered, got ' + memberRows);
  const inviteStaffBtnOwner = await page.locator('button[onclick="inviteTeamMember(\'staff\')"]').count();
  const inviteAdminBtnOwner = await page.locator('button[onclick="inviteTeamMember(\'admin\')"]').count();
  assert(inviteStaffBtnOwner === 1, 'owner sees invite-staff button');
  assert(inviteAdminBtnOwner === 1, 'owner sees invite-admin button');
  const removeButtonsOwner = await page.locator('#team-body .list-card').nth(1).locator('button[aria-label="Remove"]').count();
  assert(removeButtonsOwner === 2, 'owner can remove both staff and admin rows, got ' + removeButtonsOwner);

  // ── 3. Invite flow: click invite-staff, link renders ──────────────────
  await page.click('button[onclick="inviteTeamMember(\'staff\')"]');
  await page.waitForTimeout(200);
  assert(lastInviteRole === 'staff', 'invite request sent with role=staff');
  const inviteLinkInput = await page.locator('#team-invite-link-body input[readonly]').count();
  assert(inviteLinkInput === 1, 'invite link input rendered after successful invite');
  const inviteLinkVal = await page.locator('#team-invite-link-body input[readonly]').inputValue();
  assert(inviteLinkVal.includes('teamInvite=tok-staff'), 'invite link contains the token, got: ' + inviteLinkVal);

  // ── 4. Remove a member ─────────────────────────────────────────────────
  page.once('dialog', d => d.accept());
  await page.locator('#team-body .list-card').nth(1).locator('button[aria-label="Remove"]').first().click();
  await page.waitForTimeout(300);
  assert(teamState.members.length === 1, 'server-side member list down to 1 after remove, got ' + teamState.members.length);
  const memberRowsAfterRemove = await page.locator('#team-body .list-card').nth(1).locator('.list-row').count();
  assert(memberRowsAfterRemove === 1, 're-rendered roster shows 1 row after remove, got ' + memberRowsAfterRemove);

  // ── 5. Team admin: can invite staff only, can remove staff only ───────
  teamState = { members: [
    { cuid: 'staff-1', name: 'Staff One', role: 'staff', joinedAt: '2026-07-01' },
    { cuid: 'admin-2', name: 'Admin Two', role: 'admin', joinedAt: '2026-07-03' },
  ], myRole: 'admin', ownerName: 'Test Owner' };
  await setEntitlements(teamAdmin);
  await page.evaluate(() => window.renderTeamSection && window.renderTeamSection());
  await page.waitForTimeout(300);
  const inviteStaffBtnAdmin = await page.locator('button[onclick="inviteTeamMember(\'staff\')"]').count();
  const inviteAdminBtnAdmin = await page.locator('button[onclick="inviteTeamMember(\'admin\')"]').count();
  assert(inviteStaffBtnAdmin === 1, 'admin sees invite-staff button');
  assert(inviteAdminBtnAdmin === 0, 'admin does NOT see invite-admin button (owner-only)');
  const removeButtonsAdmin = await page.locator('#team-body .list-card').nth(1).locator('button[aria-label="Remove"]').count();
  assert(removeButtonsAdmin === 1, 'admin can only remove the staff row, not the other admin, got ' + removeButtonsAdmin);

  // ── 6. Team staff: read-only roster, no invite/remove controls ────────
  teamState = { members: [
    { cuid: 'staff-1', name: 'Staff One', role: 'staff', joinedAt: '2026-07-01' },
  ], myRole: 'staff', ownerName: 'Test Owner' };
  await setEntitlements(teamStaff);
  await page.evaluate(() => window.renderTeamSection && window.renderTeamSection());
  await page.waitForTimeout(300);
  const inviteBtnsStaff = await page.locator('#team-body button[onclick^="inviteTeamMember"]').count();
  assert(inviteBtnsStaff === 0, 'staff sees no invite buttons at all');
  const removeButtonsStaff = await page.locator('#team-body .list-card').nth(1).locator('button[aria-label="Remove"]').count();
  assert(removeButtonsStaff === 0, 'staff sees no remove buttons');

  // ── 7. Team checkout prompt on a non-team plan ─────────────────────────
  await setEntitlements(basePro);
  await page.evaluate(() => window.switchScreen && window.switchScreen('more'));
  await page.waitForTimeout(300);
  page.once('dialog', d => d.accept('4'));
  await page.evaluate(() => window.startTeamCheckout && window.startTeamCheckout());
  await page.waitForTimeout(200);
  assert(lastCheckoutSeats === 4, 'team checkout requested with the prompted seat count, got ' + lastCheckoutSeats);

  // Invalid seat count (below the 2-seat minimum) is rejected client-side.
  lastCheckoutSeats = null;
  page.once('dialog', d => d.accept('1'));
  await page.evaluate(() => window.startTeamCheckout && window.startTeamCheckout());
  await page.waitForTimeout(200);
  assert(lastCheckoutSeats === null, 'a seat count below 2 is rejected without calling checkout');

  // ── 8. ?teamInvite= redemption flow ────────────────────────────────────
  await page.evaluate(() => { sessionStorage.setItem('sidekick_team_invite', 'tok-redeem-test'); });
  await page.evaluate(() => window.maybeRedeemTeamInvite && window.maybeRedeemTeamInvite());
  await page.waitForTimeout(200);
  assert(joinedToken === 'tok-redeem-test', 'maybeRedeemTeamInvite() calls teamJoin with the stored token');
  const tokenCleared = await page.evaluate(() => sessionStorage.getItem('sidekick_team_invite'));
  assert(tokenCleared === null, 'invite token is cleared from sessionStorage after redemption attempt');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
