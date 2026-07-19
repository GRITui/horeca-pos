/* Sidekick — invoices.js  (M2 INVOICING + PromptPay)
 *
 * OWNED BY the invoicing agent. Replaces the stub entirely.
 * Loaded AFTER app.js and tax.js, so app.js globals (dbAll, dbAdd, dbPut,
 * dbDel, cuid, nowISO, todayISO, money, fmt, curSym, htmlEsc, attrEsc, toast,
 * switchScreen, settings, customers, services, jobs, currentUser, isGuest) and
 * window.computeTax are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderInvoices()          — fills #invoices-body
 *   - openInvoiceForm(fromJobId?, prefillQuote?) — create/edit invoice UI.
 *     prefillQuote (from docgen.js's Quote → Invoice conversion, or app.js's
 *     milestone/unbilled-time draft flows) is {clientId, clientName,
 *     lineItems, linkMeta?} and takes priority over fromJobId for prefill.
 *     linkMeta, if present, is {type:'milestone', jobId, milestoneId} or
 *     {type:'unbilled', jobId, timeEntryIds} — on actual save (not cancel),
 *     app.js's window.onMilestoneInvoiceCreated/onUnbilledTimeInvoiceCreated
 *     is called to link the invoice back, WITHOUT touching Pipeline stage
 *     (that's fromJobId + onEngagementInvoiceCreated's job, kept separate on
 *     purpose since a job can have several milestones before it's actually done).
 *
 * Everything below is self-contained: EMVCo PromptPay payload builder,
 * CRC16-CCITT-FALSE, and a byte-mode QR encoder (Nayuki-style, reference
 * algorithm) — no CDN, no network, no external libraries. Fully localized
 * (en/th) via app.js's t()/I18N; light-mode, THB via money()/curSym().
 */
'use strict';

(function () {

  // ══════════════════════════════════════════════════════════════════════
  //  Small local helpers
  // ══════════════════════════════════════════════════════════════════════
  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'invoices';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }
  function n(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function money2(v) { return money(v, 2); }

  async function loadInvoices() {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid);
    rows.sort((a, b) => {
      const d = String(b.issueDate || '').localeCompare(String(a.issueDate || ''));
      if (d !== 0) return d;
      return String(b.number || '').localeCompare(String(a.number || ''));
    });
    return rows;
  }

  // Shared with docgen.js's quote/receipt numbering — see app.js's nextDocNumber().
  function nextNumber(rows) { return nextDocNumber(rows, 'INV'); }

  function statusChip(status) {
    const map = {
      paid: ['chip-paid', t('inv_status_paid')],
      overdue: ['chip-overdue', t('inv_status_overdue')],
      sent: ['chip-due', t('inv_status_sent')],
      draft: ['', t('inv_status_draft')],
    };
    const [cls, label] = map[status] || map.draft;
    if (!cls) {
      return `<span class="chip" style="background:var(--border);color:var(--text3)">${label}</span>`;
    }
    return `<span class="chip ${cls}">${label}</span>`;
  }

  // 50 Tawi certificate tracker (only shown once WHT actually applies to this
  // invoice) — the certificate is the client's proof of the tax withheld,
  // needed to claim it as a credit at filing time. Not wired to a real "chase
  // via LINE" send (that's the LINE Messaging backend, not built here) —
  // this just tracks RECEIVED/MISSING and days outstanding, and the button
  // toggles that status locally.
  function tawiTrackerHtml(inv) {
    const received = inv.tawiStatus === 'received';
    const days = inv.issueDate ? Math.max(0, Math.round((Date.now() - new Date(inv.issueDate + 'T12:00:00').getTime()) / 86400000)) : 0;
    const unit = days === 1 ? t('day_singular') : t('day_plural');
    return `<div style="margin:0 20px 10px;background:${received ? 'var(--brand-tint)' : 'var(--marigold-tint)'};border-radius:var(--radius-sm);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-size:12px;font-weight:800;color:${received ? 'var(--brand)' : 'var(--marigold-ink)'}">${esc(t('tawi_cert_title'))}</div>
          <div style="font-size:11px;color:var(--text3)">${received ? esc(t('tawi_received')) : esc(t('tawi_missing_template').replace('{n}', days).replace('{unit}', unit))}</div>
        </div>
        <button type="button" id="inv-tawi-toggle" style="flex-shrink:0;padding:8px 12px;border:1px solid ${received ? 'var(--brand)' : 'var(--marigold)'};background:none;color:${received ? 'var(--brand)' : 'var(--marigold-ink)'};border-radius:9px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">${received ? esc(t('mark_missing_btn')) : esc(t('mark_received_btn'))}</button>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  LIST SCREEN  →  #invoices-body
  // ══════════════════════════════════════════════════════════════════════
  async function renderInvoices() {
    const el = document.getElementById('invoices-body');
    if (!el) return;
    const rows = await loadInvoices();

    const btn = `<button type="button" id="inv-new-btn" class="btn-submit" style="width:100%;margin:0 0 16px">${esc(t('new_invoice_btn'))}</button>`;

    if (!rows.length) {
      el.innerHTML = btn +
        `<div class="empty"><div class="empty-icon">🧾</div>
           <p>${esc(t('no_invoices'))}</p>
           <span>${esc(t('no_invoices_sub'))}</span>
         </div>`;
      document.getElementById('inv-new-btn').addEventListener('click', () => openInvoiceForm());
      return;
    }

    // Outstanding total (client-pays for non-paid invoices) and Overdue
    // (the subset of those past their due date) — two separate figures per
    // the redesign handoff, Overdue in the danger tint since it's the more
    // urgent of the two, not just a warmer shade of the same number.
    const todayStr = todayISO();
    let outstanding = 0, overdue = 0, overdueCount = 0;
    rows.forEach(r => {
      if (r.status === 'paid') return;
      outstanding += n(r.clientPays);
      if (r.dueDate && r.dueDate < todayStr) { overdue += n(r.clientPays); overdueCount++; }
    });
    // Money dashboard (7c): liquid revenue (cash actually received, net of
    // any WHT withheld) is the headline; withheld WHT is tracked separately
    // as a tax credit — the two are never added back together, since mixing
    // "money in hand" with "a credit to claim later" is exactly the
    // confusion this dashboard exists to avoid.
    let liquidRevenue = 0, taxCredits = 0;
    rows.forEach(r => { if (r.status === 'paid') { liquidRevenue += n(r.youReceive); taxCredits += n(r.wht); } });

    const summaryCard = (label, amt, danger) => `<div style="background:var(--card);border:0.5px solid ${danger ? 'var(--overdue)' : 'var(--border)'};border-radius:var(--radius-sm);padding:12px 14px;flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;color:${danger ? 'var(--overdue)' : 'var(--text3)'}">${esc(label)}</div>
        <div class="tnum" style="font-size:18px;font-weight:800;color:${danger ? 'var(--overdue)' : 'var(--text)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(money2(amt))}</div>
      </div>`;
    const summary = `<div style="display:flex;gap:8px;margin:0 0 8px">
        ${summaryCard(t('inv_outstanding_label'), outstanding, false)}
        ${summaryCard(t('inv_status_overdue') + (overdueCount ? ` (${overdueCount})` : ''), overdue, overdue > 0)}
      </div>
      <div style="display:flex;gap:8px;margin:0 0 14px">
        ${summaryCard(t('liquid_revenue_label'), liquidRevenue, false)}
        ${summaryCard(t('wht_tax_credits_label'), taxCredits, false)}
      </div>`;

    const list = '<div class="list-card">' + rows.map(r => {
      const sub = [esc(r.clientName || t('no_client_option')), esc(fmtInvDate(r.issueDate))].filter(Boolean).join(' · ');
      return `<div class="list-row" data-inv="${r.id}" tabindex="0" role="button">
        <div class="list-icon">🧾</div>
        <div class="list-main">
          <div class="list-title tnum">${esc(r.number || t('invoice_word'))}</div>
          <div class="list-sub">${sub}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum">${esc(money2(r.clientPays))}</div>
          <div class="list-amt-sub" style="margin-top:3px">${statusChip(r.status)}</div>
        </div>
      </div>`;
    }).join('') + '</div>';

    el.innerHTML = btn + summary + list;
    document.getElementById('inv-new-btn').addEventListener('click', () => openInvoiceForm());
    el.querySelectorAll('[data-inv]').forEach(row => {
      const open = () => openInvoiceDetail(parseInt(row.getAttribute('data-inv'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }
  window.renderInvoices = renderInvoices;

  function fmtInvDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INVOICE FORM (create / edit)
  // ══════════════════════════════════════════════════════════════════════
  let lines = [];        // working line items: {description, qty, unitPrice}
  let editing = null;    // full record being edited, or null on create
  let formFromJobId = null; // pipeline session this form was opened from (for engagement linking)
  let formLinkMeta = null;  // milestone/unbilled-time link to apply on actual save (see file header)

  function openInvoiceForm(fromJobId, prefillQuote) {
    editing = null;
    lines = [];
    formFromJobId = (fromJobId != null) ? fromJobId : null;
    formLinkMeta = (prefillQuote && prefillQuote.linkMeta) ? prefillQuote.linkMeta : null;

    let preClientId = '', preClientName = '';
    if (prefillQuote) {
      // Prefill from an accepted Quote document (docgen.js) — every quote
      // line item carries over as its own invoice line.
      preClientId = prefillQuote.clientId != null ? prefillQuote.clientId : '';
      preClientName = prefillQuote.clientName || '';
      (prefillQuote.lineItems || []).forEach(li => {
        lines.push({ description: li.description || '', qty: n(li.qty) || 1, unitPrice: n(li.unitPrice) });
      });
      // Pass M3-L2: quote lines never carry a serviceId (openQuoteForJob/
      // reviseQuoteForJob in app.js build fields.lineItems from plain
      // description/qty/unitPrice, and docgen.js passes them through as-is)
      // — but the engagement's own Items list (j.items) DOES know which
      // catalog record each item line came from. Re-derive it defensively by
      // matching each item to an unclaimed prefill line with the same
      // name+qty+unitPrice, so a job's items still flow through Quote ->
      // Invoice with serviceId stamped for app.js's paid-time stock
      // decrement. First unclaimed match wins; each item claims at most one line.
      const srcJobId = fromJobId != null ? fromJobId
        : (prefillQuote.linkMeta && prefillQuote.linkMeta.jobId != null ? prefillQuote.linkMeta.jobId : null);
      const srcJob = srcJobId != null ? (typeof jobs !== 'undefined' ? jobs : []).find(x => x.id === srcJobId) : null;
      if (srcJob && (srcJob.items || []).length) {
        const claimed = new Set();
        (srcJob.items || []).forEach(it => {
          const matchIdx = lines.findIndex((li, idx) =>
            !claimed.has(idx) && li.serviceId == null &&
            li.description === it.name && n(li.qty) === n(it.qty) && n(li.unitPrice) === n(it.unitPrice));
          if (matchIdx !== -1) {
            lines[matchIdx].serviceId = it.serviceId;
            claimed.add(matchIdx);
          }
        });
      }
    } else if (fromJobId != null) {
      // Prefill from a job if requested
      const j = (typeof jobs !== 'undefined' ? jobs : []).find(x => x.id === fromJobId);
      if (j) {
        preClientName = j.client || '';
        if (j.clientId != null) preClientId = j.clientId;
        lines.push({
          description: j.serviceName || t('service_word'),
          qty: Math.max(1, n(j.count) || 1),
          unitPrice: n(j.amount),
        });
        // Pass M3-L2: engagement items carry serviceId directly (snapshotted
        // when added — see app.js's addJobItem), so app.js's
        // decrementStockForInvoicePaid can find them at paid time.
        (j.items || []).forEach(it => {
          lines.push({ description: it.name, qty: it.qty, unitPrice: it.unitPrice, serviceId: it.serviceId });
        });
      }
    }
    if (!lines.length) lines.push({ description: '', qty: 1, unitPrice: 0 });

    buildFormModal({
      title: t('new_invoice_title'),
      number: t('assigned_on_save'),
      clientId: preClientId,
      clientName: preClientName,
      clientTaxId: '',
      clientAddress: '',
      issueDate: todayISO(),
      dueDate: addDays(todayISO(), 7),
      whtPct: settingsDefault('wht', 3),
      vatPct: settingsDefault('vat', 7),
      depositPct: 0,
      status: 'draft',
      notes: '',
    }, false);
  }
  window.openInvoiceForm = openInvoiceForm;

  function openInvoiceEdit(inv) {
    editing = inv;
    formFromJobId = null;
    formLinkMeta = null;
    lines = (inv.lineItems && inv.lineItems.length)
      ? inv.lineItems.map(li => {
          const row = { description: li.description || '', qty: n(li.qty), unitPrice: n(li.unitPrice) };
          if (li.serviceId != null) row.serviceId = li.serviceId; // preserve catalog link through an edit
          return row;
        })
      : [{ description: '', qty: 1, unitPrice: 0 }];
    buildFormModal({
      title: t('edit_invoice_title'),
      number: inv.number || '',
      clientId: inv.clientId != null ? inv.clientId : '',
      clientName: inv.clientName || '',
      clientTaxId: inv.clientTaxId || '',
      clientAddress: inv.clientAddress || '',
      issueDate: inv.issueDate || todayISO(),
      dueDate: inv.dueDate || addDays(todayISO(), 7),
      whtPct: inv.whtPct != null ? inv.whtPct : settingsDefault('wht', 3),
      vatPct: inv.vatPct != null ? inv.vatPct : settingsDefault('vat', 7),
      depositPct: inv.depositPct != null ? inv.depositPct : 0,
      status: inv.status || 'draft',
      notes: inv.notes || '',
    }, true);
  }

  function settingsDefault(key, fallback) {
    const v = (typeof settings !== 'undefined' && settings) ? settings[key] : undefined;
    return (v == null || v === '') ? fallback : v;
  }

  function buildFormModal(v, isEdit) {
    closeModal('inv-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'inv-form-modal';

    const custOpts = `<option value="">${esc(t('free_text_option'))}</option>` +
      (typeof customers !== 'undefined' ? customers : []).map(c =>
        `<option value="${c.id}"${String(c.id) === String(v.clientId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

    // Pass M3-L1: 📦 prefix flags a catalog product (vs a plain service);
    // a tracked-out-of-stock product option is shown but disabled so users
    // can still see it exists, just can't line-item-add it while empty.
    const svcOpts = `<option value="">${esc(t('add_line_from_service_option'))}</option>` +
      (typeof services !== 'undefined' ? services : []).map(s => {
        const isProduct = s.kind === 'product';
        const outOfStock = isProduct && s.stockQty != null && s.stockQty === 0;
        const label = (isProduct ? '📦 ' : '') + s.name + ' · ' + money(s.rate) + (outOfStock ? ' (หมด/out of stock)' : '');
        return `<option value="${s.id}"${outOfStock ? ' disabled' : ''}>${esc(label)}</option>`;
      }).join('');

    const INV_STATUS_LABEL_KEYS = { draft: 'inv_status_draft', sent: 'inv_status_sent', paid: 'inv_status_paid', overdue: 'inv_status_overdue' };
    const statusOpts = ['draft', 'sent', 'paid', 'overdue'].map(s =>
      `<option value="${s}"${s === v.status ? ' selected' : ''}>${esc(t(INV_STATUS_LABEL_KEYS[s]))}</option>`).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${aesc(t('invoice_form_aria'))}">
        <div class="modal-handle"></div>
        <div class="modal-title">${esc(v.title)} <span style="font-size:12px;font-weight:600;color:var(--text3)">${esc(v.number)}</span></div>
        <div class="form-body">
          <div class="form-header">${esc(t('field_customer'))}</div>
          <div class="field">
            <label for="inv-cust">${esc(t('pick_client_label'))}</label>
            <select id="inv-cust">${custOpts}</select>
          </div>
          <div class="field">
            <label for="inv-cname">${esc(t('bill_to_name_label'))}</label>
            <input type="text" id="inv-cname" value="${aesc(v.clientName)}" placeholder="${aesc(t('client_company_name_ph'))}">
          </div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-ctax">${esc(t('field_taxid'))}</label><input type="text" id="inv-ctax" value="${aesc(v.clientTaxId)}"></div>
            <div class="field-half"><label for="inv-caddr">${esc(t('business_address'))}</label><input type="text" id="inv-caddr" value="${aesc(v.clientAddress)}"></div>
          </div>

          <div class="form-header">${esc(t('dates_status_header'))}</div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-issue">${esc(t('issue_date_label'))}</label><input type="date" id="inv-issue" value="${aesc(v.issueDate)}"></div>
            <div class="field-half"><label for="inv-due">${esc(t('due_date_label'))}</label><input type="date" id="inv-due" value="${aesc(v.dueDate)}"></div>
          </div>
          <div class="field">
            <label for="inv-status">${esc(t('status_label'))}</label>
            <select id="inv-status">${statusOpts}</select>
          </div>

          <div class="form-header">${esc(t('line_items_header'))}</div>
          <div id="inv-lines"></div>
          <div class="field">
            <label for="inv-svc">${esc(t('add_from_service_label'))}</label>
            <select id="inv-svc">${svcOpts}</select>
          </div>
          <div style="padding:10px 16px">
            <button type="button" id="inv-add-line" style="width:100%;padding:11px;background:var(--brand-tint);color:var(--brand);border:none;border-radius:9px;font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">${esc(t('add_blank_line_btn'))}</button>
          </div>

          <div class="form-header">${esc(t('tax_deposit_header'))}</div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-vat">${esc(t('vat'))}</label><input type="number" id="inv-vat" class="tnum" inputmode="decimal" min="0" step="0.01" value="${aesc(v.vatPct)}"></div>
            <div class="field-half"><label for="inv-wht">${esc(t('wht_pct_label'))}</label><input type="number" id="inv-wht" class="tnum" inputmode="decimal" min="0" step="0.01" value="${aesc(v.whtPct)}"></div>
          </div>
          <div class="field">
            <label for="inv-deposit">${esc(t('deposit_pct_label'))}</label>
            <input type="number" id="inv-deposit" class="tnum" inputmode="decimal" min="0" max="100" step="1" value="${aesc(v.depositPct)}">
          </div>

          <div class="form-header">${esc(t('field_notes'))}</div>
          <div class="field">
            <label for="inv-notes">${esc(t('invoice_notes_label'))}</label>
            <textarea id="inv-notes" rows="2">${esc(v.notes)}</textarea>
          </div>

          <div id="inv-totals" style="margin:8px 16px 4px;background:var(--brand-tint);border-radius:var(--radius-sm);padding:14px 16px"></div>
        </div>
        <button type="button" class="btn-submit" id="inv-save">${isEdit ? esc(t('save_changes_btn')) : esc(t('create_invoice_btn'))}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="inv-del">${esc(t('delete_invoice_btn'))}</button>` : ''}
        <button type="button" class="btn-danger" id="inv-cancel" style="border-color:var(--border-mid);color:var(--text3)">${esc(t('cancel'))}</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    // Wire controls
    overlay.querySelector('#inv-cust').addEventListener('change', onCustChange);
    overlay.querySelector('#inv-svc').addEventListener('change', onSvcChange);
    overlay.querySelector('#inv-add-line').addEventListener('click', () => {
      lines.push({ description: '', qty: 1, unitPrice: 0 });
      renderLineRows(); recalcTotals();
    });
    overlay.querySelector('#inv-save').addEventListener('click', () => saveInvoice(isEdit));
    overlay.querySelector('#inv-cancel').addEventListener('click', () => closeModal('inv-form-modal'));
    if (isEdit) overlay.querySelector('#inv-del').addEventListener('click', () => deleteInvoice(editing.id));
    ['inv-vat', 'inv-wht', 'inv-deposit'].forEach(id => {
      overlay.querySelector('#' + id).addEventListener('input', recalcTotals);
    });

    renderLineRows();
    recalcTotals();
  }

  function onCustChange(e) {
    const id = e.target.value;
    if (!id) return;
    const c = (typeof customers !== 'undefined' ? customers : []).find(x => String(x.id) === String(id));
    if (!c) return;
    const set = (sel, val) => { const el = document.querySelector(sel); if (el) el.value = val || ''; };
    set('#inv-cname', c.name);
    set('#inv-ctax', c.taxId);
    set('#inv-caddr', c.billingAddress);
  }

  function onSvcChange(e) {
    const id = e.target.value;
    if (!id) return;
    const s = (typeof services !== 'undefined' ? services : []).find(x => String(x.id) === String(id));
    if (s) {
      // serviceId stamps the line with its catalog origin — carried into
      // saveInvoice's cleanLines below, and later resolved at paid time by
      // app.js's decrementStockForInvoicePaid(). Hand-typed/blank lines
      // never get one.
      lines.push({ description: s.name || '', qty: 1, unitPrice: n(s.rate), serviceId: s.id });
      renderLineRows(); recalcTotals();
    }
    e.target.value = '';
  }

  function renderLineRows() {
    const wrap = document.getElementById('inv-lines');
    if (!wrap) return;
    if (!document.getElementById('inv-focus-style')) {
      const fs = document.createElement('style');
      fs.id = 'inv-focus-style';
      fs.textContent = '#inv-form-modal input:focus-visible,#inv-form-modal select:focus-visible,#inv-form-modal textarea:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand)}';
      document.head.appendChild(fs);
    }
    wrap.innerHTML = lines.map((li, i) => {
      const amt = n(li.qty) * n(li.unitPrice);
      const svcAttr = li.serviceId != null ? ` data-service-id="${aesc(li.serviceId)}"` : '';
      return `<div class="inv-line" data-i="${i}"${svcAttr} style="border-bottom:0.5px solid var(--border);padding:10px 16px">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input type="text" data-f="description" placeholder="${aesc(t('description_ph'))}" value="${aesc(li.description)}"
            style="flex:1;border:none;outline:none;background:transparent;font-size:15px;color:var(--text);font-family:inherit;padding:4px 0">
          <button type="button" data-rm="${i}" aria-label="${aesc(t('remove_line_aria'))}"
            style="border:none;background:none;color:var(--overdue);font-size:20px;line-height:1;cursor:pointer;padding:2px 4px">×</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
          <label style="font-size:11px;color:var(--text3);font-weight:700">${esc(t('qty_label'))}</label>
          <input type="number" data-f="qty" aria-label="${aesc(t('quantity_aria'))}" class="tnum" inputmode="decimal" min="0" step="any" value="${aesc(li.qty)}"
            style="width:64px;border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text);outline:none">
          <label style="font-size:11px;color:var(--text3);font-weight:700">${esc(t('rate_label'))}</label>
          <input type="number" data-f="unitPrice" aria-label="${aesc(t('unit_price_aria'))}" class="tnum" inputmode="decimal" min="0" step="any" value="${aesc(li.unitPrice)}"
            style="width:96px;border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text);outline:none">
          <div class="tnum" data-amt="${i}" style="margin-left:auto;font-weight:800;color:var(--text);font-size:14px">${esc(money2(amt))}</div>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.inv-line').forEach(rowEl => {
      const i = parseInt(rowEl.getAttribute('data-i'), 10);
      rowEl.querySelectorAll('[data-f]').forEach(input => {
        input.addEventListener('input', () => {
          const f = input.getAttribute('data-f');
          lines[i][f] = (f === 'description') ? input.value : n(input.value);
          const amtEl = wrap.querySelector(`[data-amt="${i}"]`);
          if (amtEl) amtEl.textContent = money2(n(lines[i].qty) * n(lines[i].unitPrice));
          recalcTotals();
        });
      });
      const rm = rowEl.querySelector('[data-rm]');
      if (rm) rm.addEventListener('click', () => {
        lines.splice(i, 1);
        if (!lines.length) lines.push({ description: '', qty: 1, unitPrice: 0 });
        renderLineRows(); recalcTotals();
      });
    });
  }

  function currentSubtotal() {
    return lines.reduce((s, li) => s + n(li.qty) * n(li.unitPrice), 0);
  }

  function recalcTotals() {
    const box = document.getElementById('inv-totals');
    if (!box) return;
    const subtotal = currentSubtotal();
    const vatPct = n(document.getElementById('inv-vat').value);
    const whtPct = n(document.getElementById('inv-wht').value);
    const depositPct = n(document.getElementById('inv-deposit').value);
    const taxRes = window.computeTax(subtotal, whtPct, vatPct);
    const deposit = taxRes.clientPays * (depositPct / 100);
    const row = (label, val, strong) =>
      `<div style="display:flex;justify-content:space-between;margin:3px 0;${strong ? 'font-weight:800;font-size:15px;color:var(--brand)' : 'font-size:13px;color:var(--text2)'}">
        <span>${esc(label)}</span><span class="tnum">${esc(val)}</span></div>`;
    box.innerHTML =
      row(t('subtotal_label'), money2(subtotal)) +
      row(t('vat_pct_row').replace('{pct}', fmt(vatPct, 2)), '+ ' + money2(taxRes.vat)) +
      row(t('wht_pct_row').replace('{pct}', fmt(whtPct, 2)), '- ' + money2(taxRes.wht)) +
      `<div style="border-top:1px solid var(--border-mid);margin:6px 0"></div>` +
      row(t('client_pays_label'), money2(taxRes.clientPays), true) +
      row(t('you_receive_label'), money2(taxRes.youReceive)) +
      (depositPct > 0 ? row(t('deposit_pct_row').replace('{pct}', fmt(depositPct, 0)), money2(deposit)) : '');
  }

  async function saveInvoice(isEdit) {
    // Validation
    document.querySelectorAll('#inv-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#inv-form-modal .field-err').forEach(el => el.remove());

    const clientName = document.getElementById('inv-cname').value.trim();
    const cleanLines = lines
      .map(li => {
        const out = { description: (li.description || '').trim(), qty: n(li.qty), unitPrice: n(li.unitPrice) };
        // serviceId only rides along for picker-created lines (see onSvcChange) —
        // a hand-typed line never gets one.
        if (li.serviceId != null) out.serviceId = li.serviceId;
        return out;
      })
      .filter(li => li.description || li.qty * li.unitPrice > 0);

    let bad = false;
    if (!clientName) { markErr('inv-cname', t('err_enter_billed_to')); bad = true; }
    if (!cleanLines.length) { toast(t('err_add_line_item')); bad = true; }
    else if (currentSubtotal() <= 0) { toast(t('err_invoice_total_zero')); bad = true; }
    if (bad) return;

    const uid = uidNow();
    const subtotal = cleanLines.reduce((s, li) => s + li.qty * li.unitPrice, 0);
    const vatPct = n(document.getElementById('inv-vat').value);
    const whtPct = n(document.getElementById('inv-wht').value);
    const depositPct = n(document.getElementById('inv-deposit').value);
    const tax = window.computeTax(subtotal, whtPct, vatPct);
    const custId = document.getElementById('inv-cust').value;

    const base = {
      uid,
      number: isEdit ? editing.number : nextNumber(await loadInvoices()),
      issueDate: document.getElementById('inv-issue').value || todayISO(),
      dueDate: document.getElementById('inv-due').value || '',
      clientId: custId ? (isNaN(parseInt(custId, 10)) ? custId : parseInt(custId, 10)) : null,
      clientName,
      clientTaxId: document.getElementById('inv-ctax').value.trim(),
      clientAddress: document.getElementById('inv-caddr').value.trim(),
      lineItems: cleanLines,
      subtotal,
      whtPct, vatPct,
      vat: tax.vat, wht: tax.wht, clientPays: tax.clientPays, youReceive: tax.youReceive,
      depositPct,
      status: document.getElementById('inv-status').value || 'draft',
      // Snapshot the whole payment-channels list at issue time (JSON
      // round-trip = deep copy) so a later Settings change never rewrites
      // what a client already saw on an issued invoice.
      paymentChannels: (typeof settings !== 'undefined' && settings && Array.isArray(settings.paymentChannels))
        ? JSON.parse(JSON.stringify(settings.paymentChannels)) : [],
      notes: document.getElementById('inv-notes').value.trim(),
      updatedAt: nowISO(),
    };

    try {
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        if (editing.paymentChannels) base.paymentChannels = editing.paymentChannels; // preserve issue-time snapshot
        if (editing.slips) base.slips = editing.slips; // preserve attached payment slips (edit form has no slip UI)
        await dbPut(STORE, base);
        if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
          SidekickBackend.mirrorInvoiceSave(base).catch(() => {});
        }
        // Same reverse hook as the detail-modal status select — an edit
        // save that transitions the status to 'paid' is the same event.
        if (editing.status !== 'paid' && base.status === 'paid' && typeof window.onInvoiceMarkedPaid === 'function') {
          try { window.onInvoiceMarkedPaid(base.id); } catch (e) { /* non-fatal */ }
        }
        // Pass M3-L1: second of three paid-transition paths (see
        // app.js's decrementStockForInvoicePaid own comment) — idempotent
        // via base.stockDecrementedAt, so overlapping calls are safe.
        if (editing.status !== 'paid' && base.status === 'paid' && typeof window.decrementStockForInvoicePaid === 'function') {
          window.decrementStockForInvoicePaid(base).catch(() => {});
        }
        toast(t('invoice_updated'));
      } else {
        base.cuid = cuid();
        const newId = await dbAdd(STORE, base);
        base.id = newId;
        toast(t('invoice_created_with_number').replace('{number}', base.number));
        if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
          SidekickBackend.mirrorInvoiceSave(base).catch(() => {});
        }
        // Engagement linking: let app.js link invoiceId onto the session + advance.
        if (formFromJobId != null && typeof window.onEngagementInvoiceCreated === 'function') {
          try { window.onEngagementInvoiceCreated(newId, formFromJobId); } catch (e) { /* non-fatal */ }
        }
        // Milestone/unbilled-time linking: separate from the above on purpose —
        // neither should advance the Pipeline stage (see file header).
        if (formLinkMeta) {
          try {
            if (formLinkMeta.type === 'milestone' && typeof window.onMilestoneInvoiceCreated === 'function') {
              window.onMilestoneInvoiceCreated(newId, formLinkMeta.jobId, formLinkMeta.milestoneId);
            } else if (formLinkMeta.type === 'unbilled' && typeof window.onUnbilledTimeInvoiceCreated === 'function') {
              window.onUnbilledTimeInvoiceCreated(newId, formLinkMeta.jobId, formLinkMeta.timeEntryIds);
            }
          } catch (e) { /* non-fatal */ }
        }
        formFromJobId = null;
        formLinkMeta = null;
      }
    } catch (err) {
      console.error(err);
      toast(t('invoice_save_failed'));
      return;
    }
    closeModal('inv-form-modal');
    renderInvoices();
  }

  function markErr(inputId, msg) {
    const input = document.getElementById(inputId);
    if (!input) { toast(msg); return; }
    const wrap = input.closest('.field, .field-half') || input.parentElement;
    wrap.classList.add('field-invalid');
    if (!wrap.querySelector('.field-err')) {
      const m = document.createElement('div');
      m.className = 'field-err';
      m.textContent = msg;
      wrap.appendChild(m);
    }
    input.addEventListener('input', function clr() {
      wrap.classList.remove('field-invalid');
      const e = wrap.querySelector('.field-err'); if (e) e.remove();
      input.removeEventListener('input', clr);
    });
  }

  async function deleteInvoice(id) {
    if (!confirm(t('delete_invoice_confirm'))) return;
    try {
      const prev = await dbGet(STORE, id);
      await dbDel(STORE, id);
      if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
        SidekickBackend.mirrorInvoiceDelete(prev.cuid).catch(() => {});
      }
    } catch (e) { console.error(e); }
    closeModal('inv-form-modal');
    closeModal('inv-detail-modal');
    toast(t('invoice_deleted'));
    renderInvoices();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INVOICE DETAIL (view + QR + print + actions)
  // ══════════════════════════════════════════════════════════════════════
  const INV_STATUS_LABEL_KEYS = { draft: 'inv_status_draft', sent: 'inv_status_sent', paid: 'inv_status_paid', overdue: 'inv_status_overdue' };

  // Shared by the status <select> and the payment-slip "Confirm payment
  // received" one-tap button — both are the same event (status → 'paid'),
  // so the save + mirror + reverse-hook logic lives in one place.
  async function transitionInvoiceStatus(inv, overlay, newStatus) {
    const wasPaid = inv.status === 'paid';
    inv.status = newStatus;
    inv.updatedAt = nowISO();
    try {
      await dbPut(STORE, inv);
      if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled())
        SidekickBackend.mirrorInvoiceSave(inv).catch(() => {});
      toast(t('status_toast_prefix') + t(INV_STATUS_LABEL_KEYS[inv.status]));
    } catch (er) { console.error(er); }
    // Pass M3-L1: first of three paid-transition paths — see app.js's
    // decrementStockForInvoicePaid own comment. Idempotent via
    // inv.stockDecrementedAt, fired before the reverse hook below but the
    // ordering doesn't matter (both are independent, fire-and-forget).
    if (newStatus === 'paid' && !wasPaid && typeof window.decrementStockForInvoicePaid === 'function') {
      window.decrementStockForInvoicePaid(inv).catch(() => {});
    }
    // Reverse hook: recording payment on the invoice is where users
    // actually mark money received — the linked pipeline card should
    // advance without a second manual "mark paid" over there. app.js
    // decides whether the job qualifies (see onInvoiceMarkedPaid).
    if (!wasPaid && inv.status === 'paid' && typeof window.onInvoiceMarkedPaid === 'function') {
      try { window.onInvoiceMarkedPaid(inv.id); } catch (er) { /* non-fatal */ }
    }
    const chip = overlay.querySelector('.modal-title .chip');
    if (chip) chip.outerHTML = statusChip(inv.status);
    const statusSelect = overlay.querySelector('#inv-d-status');
    if (statusSelect) statusSelect.value = inv.status;
    renderInvoices();
  }

  async function openInvoiceDetail(id) {
    const inv = await dbGet(STORE, id);
    if (!inv || inv.uid !== uidNow()) { toast(t('invoice_not_found')); return; }

    const backendReady = !isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled();
    // Pass M2b merge-back: a client may have attached a slip via the public
    // invoice page (app/invoice.html) directly on the server since this
    // invoice was last opened here — fire-and-forget, never blocks the
    // modal opening (see refreshInvoiceSlipsFromServer's own header).
    if (backendReady) refreshInvoiceSlipsFromServer(inv).catch(() => {});

    closeModal('inv-detail-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'inv-detail-modal';
    overlay.dataset.invId = String(id);

    const linesHtml = (inv.lineItems || []).map(li =>
      `<tr>
        <td style="padding:6px 0;color:var(--text2)">${esc(li.description || '—')}</td>
        <td class="tnum" style="padding:6px 8px;text-align:right;color:var(--text3)">${esc(fmt(n(li.qty), n(li.qty) % 1 ? 2 : 0))} × ${esc(money2(n(li.unitPrice)))}</td>
        <td class="tnum" style="padding:6px 0;text-align:right;font-weight:700">${esc(money2(n(li.qty) * n(li.unitPrice)))}</td>
      </tr>`).join('');

    const deposit = n(inv.clientPays) * (n(inv.depositPct) / 100);
    const trow = (label, val, strong) =>
      `<div style="display:flex;justify-content:space-between;margin:3px 0;${strong ? 'font-weight:800;color:var(--brand);font-size:15px' : 'font-size:13px;color:var(--text2)'}">
        <span>${esc(label)}</span><span class="tnum">${esc(val)}</span></div>`;

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${aesc(t('invoice_detail_aria'))}">
        <div class="modal-handle"></div>
        <div class="modal-title" style="display:flex;align-items:center;gap:10px">
          ${esc(inv.number || t('invoice_word'))} ${statusChip(inv.status)}
        </div>
        <div style="padding:0 20px 8px">
          <div style="font-size:14px;font-weight:700;color:var(--text)">${esc(inv.clientName || t('no_client_option'))}</div>
          ${inv.clientAddress ? `<div style="font-size:12px;color:var(--text3)">${esc(inv.clientAddress)}</div>` : ''}
          ${inv.clientTaxId ? `<div style="font-size:12px;color:var(--text3)">${esc(t('tax_id_prefix'))}${esc(inv.clientTaxId)}</div>` : ''}
          <div style="font-size:12px;color:var(--text3);margin-top:4px">
            ${esc(t('issued_label'))} ${esc(fmtInvDate(inv.issueDate))}${inv.dueDate ? ' · ' + esc(t('due_label')) + ' ' + esc(fmtInvDate(inv.dueDate)) : ''}
          </div>
        </div>
        <div style="padding:0 20px 8px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">${linesHtml}</table>
        </div>
        <div style="margin:6px 20px 10px;background:var(--brand-tint);border-radius:var(--radius-sm);padding:14px 16px">
          ${trow(t('subtotal_label'), money2(inv.subtotal))}
          ${trow(t('vat_pct_row').replace('{pct}', fmt(n(inv.vatPct), 2)), '+ ' + money2(inv.vat))}
          ${trow(t('wht_pct_row').replace('{pct}', fmt(n(inv.whtPct), 2)), '- ' + money2(inv.wht))}
          <div style="border-top:1px solid var(--border-mid);margin:6px 0"></div>
          ${trow(t('client_pays_label'), money2(inv.clientPays), true)}
          ${trow(t('you_receive_label'), money2(inv.youReceive))}
          ${n(inv.depositPct) > 0 ? trow(t('deposit_pct_row').replace('{pct}', fmt(n(inv.depositPct), 0)), money2(deposit)) : ''}
        </div>
        ${inv.notes ? `<div style="padding:0 20px 8px;font-size:12px;color:var(--text3)">${esc(inv.notes)}</div>` : ''}

        ${n(inv.whtPct) > 0 ? tawiTrackerHtml(inv) : ''}

        <div id="inv-qr-wrap" style="padding:6px 20px 10px;text-align:center"></div>

        <div id="inv-slip-wrap" style="padding:0 20px 14px"></div>

        <div style="display:grid;grid-template-columns:${backendReady ? '1fr 1fr 1fr' : '1fr 1fr'};gap:8px;padding:0 16px 10px">
          <button type="button" id="inv-d-edit" style="padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">${esc(t('edit_btn'))}</button>
          <button type="button" id="inv-d-print" style="padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">${esc(t('print_pdf_btn'))}</button>
          ${backendReady ? `<button type="button" id="inv-d-share" style="padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">${esc(t('inv_share_btn'))}</button>` : ''}
        </div>
        <div style="padding:0 16px 4px">
          <label for="inv-d-status" style="display:block;font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px">${esc(t('change_status_label'))}</label>
          <select id="inv-d-status" style="width:100%;padding:11px;border:1px solid var(--border);border-radius:9px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text)">
            ${['draft', 'sent', 'paid', 'overdue'].map(s => `<option value="${s}"${s === inv.status ? ' selected' : ''}>${esc(t(INV_STATUS_LABEL_KEYS[s]))}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn-danger" id="inv-d-close" style="border-color:var(--border-mid);color:var(--text3);margin-top:12px">${esc(t('close_btn'))}</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    // Payment channels (PromptPay QR + any bank/cash/other reference text)
    renderPaymentChannelsInto(document.getElementById('inv-qr-wrap'), inv);
    // Payment slips (attach/view/remove + one-tap "confirm paid")
    renderSlipSection(overlay, inv);

    overlay.querySelector('#inv-d-edit').addEventListener('click', () => { closeModal('inv-detail-modal'); openInvoiceEdit(inv); });
    overlay.querySelector('#inv-d-print').addEventListener('click', () => printInvoice(inv));
    const shareBtn = overlay.querySelector('#inv-d-share');
    if (shareBtn) shareBtn.addEventListener('click', () => copyInvoiceShareLink(inv));
    overlay.querySelector('#inv-d-close').addEventListener('click', () => closeModal('inv-detail-modal'));
    const tawiBtn = overlay.querySelector('#inv-tawi-toggle');
    if (tawiBtn) tawiBtn.addEventListener('click', async () => {
      inv.tawiStatus = inv.tawiStatus === 'received' ? 'missing' : 'received';
      inv.updatedAt = nowISO();
      try { await dbPut(STORE, inv); } catch (er) { console.error(er); }
      closeModal('inv-detail-modal');
      openInvoiceDetail(id);
    });
    overlay.querySelector('#inv-d-status').addEventListener('change', async (e) => {
      await transitionInvoiceStatus(inv, overlay, e.target.value);
      renderSlipSection(overlay, inv); // confirm-paid button hides once status is 'paid'
    });
  }

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  SHARE LINK  (Pass M2b: the shareable client-facing public invoice page)
  // ══════════════════════════════════════════════════════════════════════
  // Builds the app/invoice.html URL from this invoice's own cuid — the same
  // capability-token model as app/book.html's ?u= link: whoever holds the
  // link can view (and attach a slip to) this ONE invoice, nothing else.
  // Copy-with-fallback shape duplicated from app/followups.js's
  // copyMessage()/fallbackCopy() (a separate self-contained IIFE, nothing to
  // import from) rather than a shared helper.
  async function copyInvoiceShareLink(inv) {
    const url = new URL('invoice.html?i=' + encodeURIComponent(inv.cuid), location.href).href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        toast(t('inv_share_copied'));
        return;
      } catch (e) { /* fall through to the textarea fallback below */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      document.execCommand('copy');
      toast(t('inv_share_copied'));
    } catch (e) {
      console.error(e);
      toast(url); // last resort: put the raw link in the toast so it's at least visible to copy by hand
    } finally {
      textarea.remove();
    }
  }

  // Pass M2b merge-back: a client can attach a payment slip straight from
  // the public invoice page (app/invoice.html → api/invoice-public.js POST)
  // without ever touching this app — that lands on the SERVER row only.
  // This is what pulls it into the freelancer's local IndexedDB copy, the
  // next time she opens this invoice here. Fire-and-forget from
  // openInvoiceDetail(): fetches the server's current slips for this one
  // cuid, appends whichever ids the local record doesn't already have (by
  // id, not by array length — a locally-removed slip must not silently
  // come back from the server), dbPut()s if anything changed, and — only if
  // the SAME invoice's detail modal is still the one open when the
  // (network-latency-bound) fetch resolves — re-renders the slip section
  // and toasts. One-directional on purpose: a client can never delete a
  // slip, so this only ever adds; a slip the freelancer deleted locally
  // stays deleted (local wins, never re-synced back in). Swallows every
  // error silently — offline is the normal case for most opens, not a bug.
  async function refreshInvoiceSlipsFromServer(inv) {
    if (!inv || !inv.cuid || typeof SidekickBackend === 'undefined' || typeof SidekickBackend.invoiceFetchByCuid !== 'function') return;
    try {
      const serverInv = await SidekickBackend.invoiceFetchByCuid(inv.cuid);
      if (!serverInv || !Array.isArray(serverInv.slips) || !serverInv.slips.length) return;

      const local = await dbGet(STORE, inv.id);
      if (!local || local.uid !== uidNow()) return; // invoice gone / account switched since the fetch started
      const localIds = new Set((local.slips || []).map(s => s.id));
      const missing = serverInv.slips.filter(s => s && s.id && !localIds.has(s.id));
      if (!missing.length) return;

      local.slips = [...(local.slips || []), ...missing];
      local.updatedAt = nowISO();
      await dbPut(STORE, local);
      inv.slips = local.slips; // keep the in-memory object any open modal closure already holds in sync

      const overlay = document.getElementById('inv-detail-modal');
      if (overlay && overlay.dataset.invId === String(inv.id)) {
        renderSlipSection(overlay, local);
      }
      toast(t('inv_slips_synced').replace('{n}', missing.length));
    } catch (e) { /* offline/network error — silent, this is a background sync */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PAYMENT SLIPS (attach/view/remove + one-tap "confirm paid")
  //  inv.slips = [{id, dataUrl, at}], an embedded array like lineItems — no
  //  DB_VER bump, it's just a new field on an existing record. Photos are
  //  downscaled client-side (readSlipFile) before storage so IndexedDB rows
  //  and the mirror POST body stay well under Vercel's ~4.5MB cap.
  // ══════════════════════════════════════════════════════════════════════
  function slipSectionHtml(inv) {
    const slips = Array.isArray(inv.slips) ? inv.slips : [];
    const thumbs = slips.map(s => `
        <div style="position:relative;display:inline-block;margin:0 8px 8px 0">
          <img src="${aesc(s.dataUrl)}" data-slip-view="${aesc(s.id)}" style="height:72px;width:72px;object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:pointer;display:block">
          <button type="button" data-slip-remove="${aesc(s.id)}" aria-label="${aesc(t('slip_remove_confirm'))}" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:none;background:var(--overdue);color:#fff;font-size:12px;line-height:20px;text-align:center;cursor:pointer;padding:0">✕</button>
        </div>`).join('');
    return `
      <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:8px">${esc(t('slip_section_title'))}</div>
      ${slips.length
        ? `<div style="display:flex;flex-wrap:wrap">${thumbs}</div>`
        : `<div style="font-size:12px;color:var(--text3);margin-bottom:8px">${esc(t('slip_none_hint'))}</div>`}
      <input type="file" accept="image/*" id="inv-slip-file" style="display:none">
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" id="inv-slip-attach" style="flex:1;padding:11px;border:1.5px dashed var(--border-mid);background:none;color:var(--text2);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer">${esc(t('slip_attach_btn'))}</button>
        ${inv.status !== 'paid' ? `<button type="button" id="inv-slip-confirm-paid" style="flex:1;padding:11px;border:none;background:var(--pine,#22554B);color:#fff;border-radius:var(--radius-sm);font-weight:800;font-family:inherit;font-size:13px;cursor:pointer">${esc(t('slip_confirm_paid_btn'))}</button>` : ''}
      </div>`;
  }

  // Rebuilds #inv-slip-wrap in place and rewires its handlers (innerHTML
  // replacement drops old listeners, so every mutation re-renders through
  // here rather than patching the DOM piecemeal).
  function renderSlipSection(overlay, inv) {
    const wrap = overlay.querySelector('#inv-slip-wrap');
    if (!wrap) return;
    wrap.innerHTML = slipSectionHtml(inv);

    const fileInput = wrap.querySelector('#inv-slip-file');
    wrap.querySelector('#inv-slip-attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const dataUrl = await readSlipFile(file);
      if (!dataUrl) { toast(t('slip_invalid_toast')); return; }
      inv.slips = Array.isArray(inv.slips) ? inv.slips : [];
      inv.slips.push({ id: cuid(), dataUrl, at: nowISO() });
      inv.updatedAt = nowISO();
      try {
        await dbPut(STORE, inv);
        if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled())
          SidekickBackend.mirrorInvoiceSave(inv).catch(() => {});
      } catch (er) { console.error(er); }
      renderSlipSection(overlay, inv);
      toast(t('slip_added_toast'));
    });

    const confirmBtn = wrap.querySelector('#inv-slip-confirm-paid');
    if (confirmBtn) confirmBtn.addEventListener('click', async () => {
      await transitionInvoiceStatus(inv, overlay, 'paid');
      renderSlipSection(overlay, inv);
    });

    wrap.querySelectorAll('[data-slip-view]').forEach(img => {
      img.addEventListener('click', () => openSlipViewer(inv, img.getAttribute('data-slip-view')));
    });
    wrap.querySelectorAll('[data-slip-remove]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(t('slip_remove_confirm'))) return;
        const id = btn.getAttribute('data-slip-remove');
        inv.slips = (inv.slips || []).filter(s => s.id !== id);
        inv.updatedAt = nowISO();
        try {
          await dbPut(STORE, inv);
          if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled())
            SidekickBackend.mirrorInvoiceSave(inv).catch(() => {});
        } catch (er) { console.error(er); }
        renderSlipSection(overlay, inv);
        toast(t('slip_removed_toast'));
      });
    });
  }

  // Full-screen tap-anywhere-to-close viewer for a single slip.
  function openSlipViewer(inv, id) {
    const s = (inv.slips || []).find(x => x.id === id);
    if (!s) return;
    const v = document.createElement('div');
    v.id = 'inv-slip-viewer';
    v.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px';
    v.innerHTML = `<img src="${aesc(s.dataUrl)}" style="max-width:100%;max-height:100%;border-radius:8px;display:block">`;
    v.addEventListener('click', () => v.remove());
    document.body.appendChild(v);
  }

  // FileReader → Image → canvas downscale (longest side ≤ 1200px) → JPEG
  // q0.8. A raw phone photo runs 5-12MB; this keeps IndexedDB rows and the
  // mirror POST body small. Resolves null for a non-image or unreadable file.
  function readSlipFile(file) {
    return new Promise((resolve) => {
      if (!file || !/^image\//.test(file.type)) { resolve(null); return; }
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const MAX = 1200;
          let w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { resolve(null); return; }
          if (w > MAX || h > MAX) {
            if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
            else { w = Math.round(w * MAX / h); h = MAX; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          try { resolve(canvas.toDataURL('image/jpeg', 0.8)); } catch (e) { resolve(null); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Payment channels: PromptPay EMVCo payload + QR render, plus plain
  //  reference text for bank/cash/other channels (app.js owns the settings
  //  CRUD for the saved channel list — PAYMENT_CHANNEL_TYPES/renderPaymentChannels()).
  // ══════════════════════════════════════════════════════════════════════
  // Prefer the invoice's own issue-time snapshot; fall back to live settings
  // for invoices saved before this feature existed, and further fall back to
  // a synthesized single channel from the older single-field promptpayId.
  function invoicePaymentChannels(inv) {
    if (Array.isArray(inv.paymentChannels) && inv.paymentChannels.length) return inv.paymentChannels;
    if (inv.promptpayId) return [{ id: 'legacy', type: 'promptpay', label: t('promptpay_label'), detail: inv.promptpayId }];
    if (typeof settings !== 'undefined' && settings && Array.isArray(settings.paymentChannels)) return settings.paymentChannels;
    return [];
  }
  function channelTypeLabel(type) {
    return (typeof PAYMENT_CHANNEL_TYPES !== 'undefined' && PAYMENT_CHANNEL_TYPES[type]) ? PAYMENT_CHANNEL_TYPES[type].label : type;
  }
  // Only http(s) URLs are ever rendered as a live link — rejects javascript:
  // and other schemes a pasted "payment link" could otherwise smuggle in.
  function safeHttpUrl(raw) {
    try {
      const u = new URL(String(raw || '').trim());
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  }

  // Exposed so other modules (research.js's Premium-subscribe modal) can reuse
  // the exact same PromptPay-QR-or-plain-text rendering invoices use, instead
  // of duplicating the QR-drawing pipeline. `invLike` just needs `.paymentChannels`
  // (array) and `.clientPays` (amount) — a real invoice satisfies both already.
  window.renderPaymentChannelsInto = renderPaymentChannelsInto;

  function renderPaymentChannelsInto(wrap, inv) {
    if (!wrap) return;
    const chans = invoicePaymentChannels(inv);
    if (!chans.length) {
      wrap.innerHTML = `<div style="background:var(--marigold-tint);border-radius:var(--radius-sm);padding:14px;font-size:13px;color:var(--marigold-ink)">
        ${t('add_payment_channel_hint')}</div>`;
      return;
    }
    const amount = n(inv.clientPays);
    wrap.innerHTML = chans.map((c, i) => {
      const gap = i < chans.length - 1 ? '10px' : '0';
      if (c.type === 'promptpay') {
        if (!normalizePromptPay(c.detail)) return '';
        return `<div style="margin-bottom:${gap}">
            <div style="display:inline-block;background:#fff;padding:14px;border-radius:14px;border:1px solid var(--border)">
              <canvas id="inv-qr-canvas-${i}" style="display:block;image-rendering:pixelated"></canvas>
            </div>
            <div style="font-size:12px;color:var(--text3);margin-top:6px">${esc(t('scan_promptpay_label'))} · ${esc(c.label || t('promptpay_label'))}</div>
            <div class="tnum" style="font-size:16px;font-weight:800;color:var(--text);margin-top:2px">${esc(money2(amount))}</div>
          </div>`;
      }
      if (c.type === 'paylink') {
        const href = safeHttpUrl(c.detail);
        if (href) {
          return `<div style="text-align:left;margin-bottom:${gap}">
              <div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">${esc(c.label || channelTypeLabel(c.type))}</div>
              <a href="${aesc(href)}" target="_blank" rel="noopener noreferrer" style="display:block;text-align:center;background:var(--pine,#22554B);color:#fff;font-weight:800;border-radius:12px;padding:12px;text-decoration:none">${esc(t('paylink_open_btn'))} · ${esc(money2(amount))}</a>
            </div>`;
        }
        // Invalid/unsafe URL → fall through to the plain-text card below.
      }
      return `<div style="text-align:left;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:${gap}">
          <div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.3px">${esc(c.label || channelTypeLabel(c.type))}</div>
          ${c.detail ? `<div style="font-size:14px;color:var(--text);white-space:pre-wrap;margin-top:4px">${esc(c.detail)}</div>` : ''}
        </div>`;
    }).join('');

    chans.forEach((c, i) => {
      if (c.type !== 'promptpay') return;
      const target = normalizePromptPay(c.detail);
      if (!target) return;
      try {
        const payload = buildPromptPayPayload(target, amount);
        const modules = qrGenerate(payload, ECL_M);
        drawQr(document.getElementById('inv-qr-canvas-' + i), modules, 6, 4);
      } catch (e) {
        console.error('QR render failed', e);
        const el = document.getElementById('inv-qr-canvas-' + i);
        if (el) el.replaceWith(Object.assign(document.createElement('div'), { textContent: t('qr_unavailable'), style: 'font-size:12px;color:var(--overdue)' }));
      }
    });
  }

  // Normalize a PromptPay proxy id → {tag, value}.
  //  tag '01' mobile: '00' + '66' + 9-digit NSN, left-padded to 13 chars.
  //  tag '02' national ID: 13 digits.
  //  tag '03' e-wallet: 15 digits.
  function normalizePromptPay(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 15) return { tag: '03', value: digits };
    // 13-digit '0066'-prefixed value is the app's normalized mobile form → mobile (tag 01).
    if (digits.length === 13 && digits.startsWith('0066')) return { tag: '01', value: digits };
    // 13-digit non-'00' value is a real Thai national ID (never begins with '00') → tag 02.
    if (digits.length === 13 && !digits.startsWith('00')) return { tag: '02', value: digits };
    // Treat as a Thai mobile number.
    let nsn = digits;
    if (nsn.length === 10 && nsn.charAt(0) === '0') nsn = nsn.slice(1);      // 0812345678 -> 812345678
    else if (nsn.length === 11 && nsn.slice(0, 2) === '66') nsn = nsn.slice(2); // 66812345678 -> 812345678
    else if (nsn.length === 12 && nsn.slice(0, 3) === '660') nsn = nsn.slice(3);
    if (nsn.length !== 9) return null; // not a recognizable mobile / id
    let value = '66' + nsn;            // 66812345678 (11)
    value = ('0000000000000' + value).slice(-13); // -> 0066812345678
    return { tag: '01', value: value };
  }

  function tlv(id, value) {
    const len = String(value.length).padStart(2, '0');
    return id + len + value;
  }

  function buildPromptPayPayload(target, amount) {
    const f00 = tlv('00', '01');           // payload format indicator
    const f01 = tlv('01', '12');           // dynamic (amount present)
    const merchant = tlv('00', 'A000000677010111') + tlv(target.tag, target.value);
    const f29 = tlv('29', merchant);       // merchant account info (PromptPay)
    const f53 = tlv('53', '764');          // currency THB
    const f54 = tlv('54', Number(amount).toFixed(2)); // amount, 2 decimals
    const f58 = tlv('58', 'TH');           // country
    let s = f00 + f01 + f29 + f53 + f54 + f58 + '6304';
    return s + crc16ccitt(s);
  }

  // CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
  function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) & 0xFF) << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  QR CODE ENCODER  (byte mode; reference algorithm, self-contained)
  //  Based on the public-domain Nayuki QR Code generator algorithm.
  // ══════════════════════════════════════════════════════════════════════
  // ECC level: {ordinal, formatBits}
  const ECL_L = { o: 0, f: 1 }, ECL_M = { o: 1, f: 0 }, ECL_Q = { o: 2, f: 3 }, ECL_H = { o: 3, f: 2 };

  const ECC_CODEWORDS_PER_BLOCK = [
    // 0 is unused (version starts at 1); Version 1..40
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
  ];
  const NUM_EC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
  ];

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ecl.o][ver] * NUM_EC_BLOCKS[ecl.o][ver];
  }

  // GF(256) multiply with QR primitive 0x11D
  function rsMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    const result = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= rsMul(coef, factor); });
    }
    return result;
  }

  function addEccAndInterleave(data, ver, ecl) {
    const numBlocks = NUM_EC_BLOCKS[ecl.o][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.o][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const div = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - blockEccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortLen - blockEccLen || j >= numShort) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function alignPatternPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const size = ver * 4 + 17;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function qrGenerate(text, ecl) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);

    // Choose smallest version that fits
    let ver;
    for (ver = 1; ; ver++) {
      const cap = getNumDataCodewords(ver, ecl) * 8;
      const ccbits = ver <= 9 ? 8 : 16;
      const needed = 4 + ccbits + bytes.length * 8;
      if (needed <= cap) break;
      if (ver >= 40) throw new Error('Data too long for QR');
    }
    const ccbits = ver <= 9 ? 8 : 16;
    const capacity = getNumDataCodewords(ver, ecl) * 8;

    // Bit buffer
    const bb = [];
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    append(0x4, 4);                 // byte mode indicator
    append(bytes.length, ccbits);   // char count
    for (const b of bytes) append(b, 8);
    append(0, Math.min(4, capacity - bb.length)); // terminator
    while (bb.length % 8 !== 0) bb.push(0);
    for (let pad = 0xEC; bb.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);

    // Bits -> data codeword bytes
    const dataCw = [];
    for (let i = 0; i < bb.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j];
      dataCw.push(v);
    }

    const allCw = addEccAndInterleave(dataCw, ver, ecl);
    return buildMatrix(ver, ecl, allCw);
  }

  function buildMatrix(ver, ecl, codewords) {
    const size = ver * 4 + 17;
    const modules = [];
    const isFn = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark; isFn[y][x] = true;
    };

    // Timing patterns
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

    // Finder patterns
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // Alignment patterns
    const ap = alignPatternPositions(ver);
    const na = ap.length;
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        const cx = ap[i], cy = ap[j];
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // Reserve format & version areas (drawn properly later)
    drawFormat(ecl, 0, size, setFn); // dummy, marks function cells
    drawVersion(ver, size, setFn);

    // Draw data codewords (zigzag)
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let jj = 0; jj < 2; jj++) {
          const x = right - jj;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    // Mask selection
    let bestMask = 0, minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(modules, isFn, size, m);
      drawFormat(ecl, m, size, (x, y, d) => { modules[y][x] = d; });
      const p = penalty(modules, size);
      if (p < minPenalty) { minPenalty = p; bestMask = m; }
      applyMask(modules, isFn, size, m); // undo
    }
    applyMask(modules, isFn, size, bestMask);
    drawFormat(ecl, bestMask, size, (x, y, d) => { modules[y][x] = d; });

    return modules;
  }

  function drawFormat(ecl, mask, size, put) {
    const data = (ecl.f << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    // top-left, split around finder
    for (let i = 0; i <= 5; i++) put(8, i, getBit(bits, i));
    put(8, 7, getBit(bits, 6));
    put(8, 8, getBit(bits, 7));
    put(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, getBit(bits, i));
    // second copy
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, getBit(bits, i));
    put(8, size - 8, true); // dark module
  }

  function drawVersion(ver, size, setFn) {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, color);
      setFn(b, a, color);
    }
  }

  function applyMask(modules, isFn, size, mask) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFn[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules, size) {
    let result = 0;
    // Rows
    for (let y = 0; y < size; y++) {
      let color = false, run = 0;
      let hist = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          finderAddHistory(run, hist, size);
          if (!color) result += finderCount(hist) * 40;
          color = modules[y][x]; run = 1;
        }
      }
      result += finderTerminate(color, run, hist, size) * 40;
    }
    // Columns
    for (let x = 0; x < size; x++) {
      let color = false, run = 0;
      let hist = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          finderAddHistory(run, hist, size);
          if (!color) result += finderCount(hist) * 40;
          color = modules[y][x]; run = 1;
        }
      }
      result += finderTerminate(color, run, hist, size) * 40;
    }
    // 2x2 blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    // Balance
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
  function finderAddHistory(run, hist, size) {
    if (hist[0] === 0) run += size; // white border before first run
    hist.pop();
    hist.unshift(run);
  }
  function finderCount(hist) {
    const n0 = hist[1];
    const core = n0 > 0 && hist[2] === n0 && hist[3] === n0 * 3 && hist[4] === n0 && hist[5] === n0;
    return (core && hist[0] >= n0 * 4 && hist[6] >= n0 ? 1 : 0)
      + (core && hist[6] >= n0 * 4 && hist[0] >= n0 ? 1 : 0);
  }
  function finderTerminate(color, run, hist, size) {
    if (color) { finderAddHistory(run, hist, size); run = 0; }
    run += size;
    finderAddHistory(run, hist, size);
    return finderCount(hist);
  }

  function drawQr(canvas, modules, scale, quiet) {
    if (!canvas) return;
    const nMod = modules.length;
    const dim = (nMod + quiet * 2) * scale;
    canvas.width = dim; canvas.height = dim;
    canvas.style.width = dim + 'px';
    canvas.style.height = dim + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < nMod; y++) {
      for (let x = 0; x < nMod; x++) {
        if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  // The live detail view can draw straight onto a visible <canvas>; the print
  // root is a detached/hidden DOM tree until window.print() fires, so the
  // PromptPay QR is rendered onto an offscreen canvas first and embedded as a
  // data-URI <img> instead — the only way to guarantee it survives into print.
  function paymentChannelsPrintHtml(inv) {
    const chans = invoicePaymentChannels(inv);
    if (!chans.length) return '';
    const amount = n(inv.clientPays);
    const blocks = chans.map(c => {
      if (c.type === 'promptpay') {
        const target = normalizePromptPay(c.detail);
        if (!target) return '';
        let dataUrl = '';
        try {
          const payload = buildPromptPayPayload(target, amount);
          const modules = qrGenerate(payload, ECL_M);
          const canvas = document.createElement('canvas');
          drawQr(canvas, modules, 6, 4);
          dataUrl = canvas.toDataURL('image/png');
        } catch (e) { console.error('print QR failed', e); return ''; }
        if (!dataUrl) return '';
        return `<div class="pi-pay-block">
            <img src="${dataUrl}" style="width:120px;height:120px;display:block">
            <div class="pi-muted" style="margin-top:4px">${esc(t('scan_promptpay_label'))} · ${esc(c.label || t('promptpay_label'))}</div>
          </div>`;
      }
      return `<div class="pi-pay-block">
          <div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:#555">${esc(c.label || channelTypeLabel(c.type))}</div>
          ${c.detail ? `<div style="white-space:pre-wrap;font-size:13px;margin-top:4px">${esc(c.detail)}</div>` : ''}
        </div>`;
    }).filter(Boolean).join('');
    if (!blocks) return '';
    return `<div class="pi-pay"><div class="pi-pay-title">${esc(t('payment_word'))}</div><div class="pi-pay-grid">${blocks}</div></div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PRINT / PDF  (print-optimized DOM + window.print(); scoped print CSS)
  // ══════════════════════════════════════════════════════════════════════
  function printInvoice(inv) {
    const fromName = esc((typeof sellerBusinessName === 'function') ? sellerBusinessName() : 'Sidekick');
    // Optional seller tax ID/address — shown only when filled in under
    // Settings > Business info, mirroring how client tax ID/address below
    // only show when the client profile has them.
    const sellerBits = [];
    if (typeof settings !== 'undefined' && settings) {
      if (settings.sellerAddress) sellerBits.push(esc(settings.sellerAddress));
      if (settings.sellerTaxId) sellerBits.push(esc(t('tax_id_prefix')) + esc(settings.sellerTaxId));
    }

    const rows = (inv.lineItems || []).map(li => {
      const amt = n(li.qty) * n(li.unitPrice);
      return `<tr>
        <td>${esc(li.description || '—')}</td>
        <td class="num">${esc(fmt(n(li.qty), n(li.qty) % 1 ? 2 : 0))}</td>
        <td class="num">${esc(money2(n(li.unitPrice)))}</td>
        <td class="num">${esc(money2(amt))}</td>
      </tr>`;
    }).join('');

    const deposit = n(inv.clientPays) * (n(inv.depositPct) / 100);

    // Remove any previous print root
    const prev = document.getElementById('inv-print-root');
    if (prev) prev.remove();
    const prevStyle = document.getElementById('inv-print-style');
    if (prevStyle) prevStyle.remove();

    const style = document.createElement('style');
    style.id = 'inv-print-style';
    style.textContent = `
      #inv-print-root{ display:none; }
      @media print{
        body > *{ display:none !important; }
        #inv-print-root{ display:block !important; position:static; }
        ${docPageSizeCss()}
      }
      #inv-print-root{ color:#111; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
      #inv-print-root .pi-wrap{ max-width:720px; margin:0 auto; padding:24px; }
      #inv-print-root h1{ font-size:26px; margin:0 0 2px; }
      #inv-print-root .pi-head{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #111; padding-bottom:12px; margin-bottom:16px; }
      #inv-print-root .pi-muted{ color:#555; font-size:13px; }
      #inv-print-root table{ width:100%; border-collapse:collapse; margin:8px 0 12px; font-size:14px; }
      #inv-print-root th,#inv-print-root td{ text-align:left; padding:8px 6px; border-bottom:1px solid #ddd; }
      #inv-print-root th.num,#inv-print-root td.num{ text-align:right; }
      #inv-print-root .pi-tot{ width:280px; margin-left:auto; font-size:14px; }
      #inv-print-root .pi-tot .r{ display:flex; justify-content:space-between; padding:3px 0; }
      #inv-print-root .pi-tot .grand{ font-weight:800; font-size:16px; border-top:2px solid #111; margin-top:4px; padding-top:6px; }
      #inv-print-root .pi-status{ display:inline-block; padding:3px 10px; border:1px solid #111; border-radius:6px; font-size:12px; text-transform:uppercase; }
      #inv-print-root .pi-notes{ margin-top:20px; font-size:12px; color:#555; }
      #inv-print-root .pi-pay{ margin-top:18px; }
      #inv-print-root .pi-pay-title{ font-weight:700; font-size:13px; margin-bottom:8px; }
      #inv-print-root .pi-pay-grid{ display:flex; flex-wrap:wrap; gap:14px; }
      #inv-print-root .pi-pay-block{ border:1px solid #ddd; border-radius:8px; padding:10px 12px; }
    `;
    document.head.appendChild(style);

    const INV_STATUS_LABEL_KEYS = { draft: 'inv_status_draft', sent: 'inv_status_sent', paid: 'inv_status_paid', overdue: 'inv_status_overdue' };
    const root = document.createElement('div');
    root.id = 'inv-print-root';
    root.innerHTML = `
      <div class="pi-wrap">
        <div class="pi-head">
          <div>
            <h1>${esc(t('invoice_word'))}</h1>
            <div class="pi-muted">${esc(inv.number || '')}</div>
            <div class="pi-muted">${esc(t('issued_label'))} ${esc(fmtInvDate(inv.issueDate))}${inv.dueDate ? ' · ' + esc(t('due_label')) + ' ' + esc(fmtInvDate(inv.dueDate)) : ''}</div>
          </div>
          <div style="text-align:right">
            ${(typeof sellerLogoDataUrl === 'function' && sellerLogoDataUrl()) ? `<img src="${attrEsc(sellerLogoDataUrl())}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;margin-bottom:6px">` : ''}
            <div style="font-weight:800;font-size:16px">${fromName}</div>
            ${sellerBits.map(b => `<div class="pi-muted">${b}</div>`).join('')}
            <div class="pi-status">${esc(t(INV_STATUS_LABEL_KEYS[inv.status || 'draft']))}</div>
          </div>
        </div>
        <div style="margin-bottom:14px">
          <div class="pi-muted">${esc(t('bill_to_label'))}</div>
          <div style="font-weight:700;font-size:15px">${esc(inv.clientName || '')}</div>
          ${inv.clientAddress ? `<div class="pi-muted">${esc(inv.clientAddress)}</div>` : ''}
          ${inv.clientTaxId ? `<div class="pi-muted">${esc(t('tax_id_prefix'))}${esc(inv.clientTaxId)}</div>` : ''}
        </div>
        <table>
          <thead><tr><th>${esc(t('description_ph'))}</th><th class="num">${esc(t('qty_label'))}</th><th class="num">${esc(t('rate_label'))}</th><th class="num">${esc(t('amount_header'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="pi-tot">
          <div class="r"><span>${esc(t('subtotal_label'))}</span><span>${esc(money2(inv.subtotal))}</span></div>
          <div class="r"><span>${esc(t('vat_pct_row').replace('{pct}', fmt(n(inv.vatPct), 2)))}</span><span>+ ${esc(money2(inv.vat))}</span></div>
          <div class="r"><span>${esc(t('wht_pct_row').replace('{pct}', fmt(n(inv.whtPct), 2)))}</span><span>- ${esc(money2(inv.wht))}</span></div>
          <div class="r grand"><span>${esc(t('client_pays_label'))}</span><span>${esc(money2(inv.clientPays))}</span></div>
          <div class="r"><span>${esc(t('you_receive_label'))}</span><span>${esc(money2(inv.youReceive))}</span></div>
          ${n(inv.depositPct) > 0 ? `<div class="r"><span>${esc(t('deposit_pct_row').replace('{pct}', fmt(n(inv.depositPct), 0)))}</span><span>${esc(money2(deposit))}</span></div>` : ''}
        </div>
        ${paymentChannelsPrintHtml(inv)}
        ${inv.notes ? `<div class="pi-notes">${esc(inv.notes)}</div>` : ''}
      </div>`;
    document.body.appendChild(root);

    const cleanup = () => {
      root.remove(); style.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => { window.print(); }, 60);
    // Safety cleanup if afterprint never fires
    setTimeout(cleanup, 60000);
  }

  // Exposed for app/invoice.html (Pass M2b's public, client-facing invoice
  // page) — self-contained by design (no app.js, no t()/settings/DOM-i18n
  // helpers), so it can't call renderPaymentChannelsInto() itself (that
  // reads t()/settings/PAYMENT_CHANNEL_TYPES). These five are the pure
  // primitives underneath it: no i18n, no `settings` read, no localized
  // strings — EMVCo payload building, QR-matrix generation, and canvas
  // drawing only. invoice.html builds its own bilingual markup around them.
  // Placed here (end of the IIFE, after ECL_M's `const` above has actually
  // run) rather than up near renderPaymentChannelsInto() — referencing a
  // `const` before its own declaration line has executed throws a temporal-
  // dead-zone ReferenceError, which would break this whole file's load.
  window.SidekickPromptPay = { buildPromptPayPayload, qrGenerate, drawQr, ECL_M, normalizePromptPay };

})();
