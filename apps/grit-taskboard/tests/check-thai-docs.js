// Sidekick — Pass E: client-facing documents render in the app language,
// with Buddhist-Era dates in Thai mode (docgen.js buildDocHtml/docDate).
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
  await page.fill('#auth-user', 'thdoc-' + Date.now());
  await page.fill('#auth-name', 'Doc Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  const QUOTE = {
    type: 'quote', title: 'Quote', number: 'SK-QUO-0001', issueDate: '2026-07-17', clientName: 'คุณสมชาย',
    fields: { validUntil: '2026-08-17', subtotal: 5000, lineItems: [{ description: 'ออกแบบโลโก้', qty: 1, unitPrice: 5000 }], notes: '' },
  };
  const RECEIPT = {
    type: 'receipt', title: 'Receipt', number: 'SK-REC-0001', issueDate: '2026-07-17', clientName: 'คุณสมหญิง',
    fields: { paymentDate: '2026-07-17', amount: 5000, method: 'PromptPay', reference: '', notes: '' },
  };

  // ── 1. Thai (default language): Thai labels + BE year ────────────────
  const th = await page.evaluate(([q, r]) => ({
    lang: curLang(),
    quote: buildDocHtml(q),
    receipt: buildDocHtml(r),
  }), [QUOTE, RECEIPT]);
  assert(th.lang === 'th', '1: default language is Thai');
  assert(th.quote.includes('ใบเสนอราคา'), '1: quote title/labels render in Thai (ใบเสนอราคา)');
  assert(th.quote.includes('2569'), '1: quote dates use the Buddhist-Era year (2026+543=2569)');
  assert(!th.quote.includes('Valid until'), '1: no English "Valid until" leaks into Thai mode');
  assert(th.quote.includes('จัดทำสำหรับ') && th.quote.includes('รวมเป็นเงิน'), '1: prepared-for + subtotal labels are Thai');
  assert(th.receipt.includes('ใบเสร็จ'), '1: receipt renders Thai title/labels');
  assert(th.receipt.includes('ได้รับเงินจาก'), '1: received-from label is Thai');
  assert(th.receipt.includes('ยืนยันว่าได้รับชำระเงินเต็มจำนวน'), '1: receipt footer is formal Thai');
  assert(th.quote.includes('คุณสมชาย'), '1: Thai client names pass through escaped-intact');

  // ── 2. Contract + NDA in Thai ─────────────────────────────────────────
  const thLegal = await page.evaluate(() => ({
    contract: buildDocHtml({ type: 'contract', title: 'Contract', issueDate: '2026-07-17', clientName: 'Client X',
      fields: { deliverables: 'งานออกแบบ', fee: 10000, startDate: '2026-08-01', endDate: '2026-09-01', terms: '' } }),
    nda: buildDocHtml({ type: 'nda', title: 'NDA', issueDate: '2026-07-17', clientName: 'Client X',
      fields: { effectiveDate: '2026-07-17', durationMonths: 12, notes: '' } }),
  }));
  assert(thLegal.contract.includes('สัญญาจ้างบริการ') && thLegal.contract.includes('ขอบเขตงานที่ส่งมอบ'), '2: contract renders Thai title + headers');
  assert(thLegal.contract.includes('ลงชื่อ:'), '2: signature block is Thai');
  assert(thLegal.nda.includes('ข้อมูลอันเป็นความลับ') && thLegal.nda.includes('12 เดือน'), '2: NDA renders Thai clauses + duration unit');

  // ── 3. Switch to English: labels revert, CE year, byte-stable EN copy ─
  await page.evaluate(async () => { await saveSetting('lang', 'en'); });
  const en = await page.evaluate(([q]) => ({ lang: curLang(), quote: buildDocHtml(q) }), [QUOTE]);
  assert(en.lang === 'en', '3: language switched to English');
  assert(en.quote.includes('Valid until:') && en.quote.includes('Subtotal:'), '3: English labels back');
  assert(en.quote.includes('2026-07-17') && !en.quote.includes('2569'), '3: English mode keeps CE ISO dates (byte-identical to pre-Pass-E)');
  assert(en.quote.includes('Quote #SK-QUO-0001'), '3: English number prefix intact');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
