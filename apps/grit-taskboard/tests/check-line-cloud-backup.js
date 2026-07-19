const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // Build the same base64url-encoded profile fragment
  // api/line-login-callback.js produces (see that file's `encoded` line) —
  // the client doesn't verify this part, just decodes it, so no real
  // signature is needed for it. `lineToken` is opaque to the client too
  // (only api/auth-register-line.js would ever verify it for real) — any
  // non-empty string is enough to test it's captured/stored/passed through
  // correctly end to end.
  function b64url(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const profile = { sub: 'Utestsub12345', name: 'Line Tester', picture: 'https://example.com/pic.jpg' };
  const encodedProfile = b64url(JSON.stringify(profile));
  const fakeLineToken = 'fake-signed-line-identity-token-abc123';

  // ── 1. Fresh LINE login: local account created with the token stored ──
  await page.goto(`http://localhost:8923/login.html#line=${encodedProfile}&lineToken=${fakeLineToken}`);
  await page.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  // A brand-new LINE account (profileComplete: false) lands on the
  // "confirm your name" step first, matching showLineProfileStep() —
  // complete it so finishLineLogin() actually runs.
  const onProfileStep = await page.locator('#s-line-profile.active').count();
  if (onProfileStep) {
    await page.click('#line-profile-name'); // just to confirm the field exists/visible
    await page.evaluate(() => window.completeLineProfile && window.completeLineProfile());
    await page.waitForTimeout(300);
  }

  const storedUser = await page.evaluate(async () => {
    const req = indexedDB.open('sidekick-v1');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const tx = db.transaction('users', 'readonly');
    const all = await new Promise((res, rej) => { const r = tx.objectStore('users').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return all.find(u => u.username === 'line:Utestsub12345') || null;
  });
  assert(storedUser, 'a local account was created for the LINE sub');
  assert(storedUser && storedUser.lineAuth === true, 'the account is marked lineAuth');
  assert(storedUser && storedUser.hash === null, 'the account has no password hash, as expected for LINE');
  assert(storedUser && storedUser.lineIdentityToken === fakeLineToken, 'the signed identity token from the redirect was stored on the local account, got: ' + (storedUser && storedUser.lineIdentityToken));

  // ── 2. enableCloudBackup() routes LINE accounts to registerLine() ─────
  let registerLineCalledWith = null;
  let registerCalledAtAll = false;
  await page.evaluate((token) => {
    const noop = async () => ({ ok: true, data: {} });
    window.SidekickBackend = {
      isEnabled: () => false,
      register: async () => { window.__registerCalled = true; return { ok: false }; },
      registerLine: async (t) => { window.__registerLineToken = t; return { ok: true, data: { token: 'fake-session-token' } }; },
      migrateUpload: async () => ({ ok: true, data: { inserted: 0 } }),
    };
  }, fakeLineToken);
  await page.evaluate(() => window.enableCloudBackup && window.enableCloudBackup());
  await page.waitForTimeout(300);
  registerLineCalledWith = await page.evaluate(() => window.__registerLineToken || null);
  registerCalledAtAll = await page.evaluate(() => window.__registerCalled || false);
  assert(registerLineCalledWith === fakeLineToken, 'enableCloudBackup() called registerLine() with the stored token, got: ' + registerLineCalledWith);
  assert(registerCalledAtAll === false, 'enableCloudBackup() did NOT call the password-based register() for a LINE account');

  // ── 3. LINE account with no stored token: clear guidance, no crash ────
  await page.evaluate(async () => {
    const req = indexedDB.open('sidekick-v1');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const all = await new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const u = all.find(x => x.username === 'line:Utestsub12345');
    u.lineIdentityToken = null; // simulate an account created before this token existed
    await new Promise((res, rej) => { const r = store.put(u); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  });
  let registerLineCalledSecondTime = false;
  await page.evaluate(() => {
    window.__registerLineToken = null;
    window.SidekickBackend.registerLine = async (t) => { window.__registerLineToken = t; return { ok: true, data: { token: 'x' } }; };
  });
  await page.evaluate(() => window.enableCloudBackup && window.enableCloudBackup());
  await page.waitForTimeout(300);
  registerLineCalledSecondTime = await page.evaluate(() => window.__registerLineToken !== null);
  assert(!registerLineCalledSecondTime, 'a LINE account with no stored token does not call registerLine() at all (nothing to prove identity with)');
  const toastText = await page.locator('.toast').textContent().catch(() => '');
  assert(toastText && toastText.length > 0, 'a guidance toast is shown instead of silently failing, got: ' + toastText);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
