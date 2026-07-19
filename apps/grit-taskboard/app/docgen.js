/* Sidekick — docgen.js  (M2 DOC-GEN)
 *
 * OWNED BY the doc-gen agent. Fills #docgen-body only. Loaded AFTER app.js
 * (and tax.js / invoices.js), so all app.js globals are available at call
 * time. English-only inline UI. Light-mode first; CSS vars follow the app's
 * existing theme tokens automatically, no dark-mode work needed here.
 *
 * Public surface: global renderDocgen() — fills #docgen-body.
 * Storage: IndexedDB store 'documents' (uid-scoped, see M2 contract shape).
 * Export/PDF: print-optimized DOM view + window.print() (no external lib).
 *
 * All modals/print root are created at runtime and appended to
 * document.body, namespaced with a `dg-` prefix to avoid colliding with
 * other modules' DOM. No shared file (app.js/index.html/styles.css) is
 * touched.
 */
'use strict';

// ─── module state ──────────────────────────────────────────────────────
let dgCurrentType = null;   // 'contract' | 'nda' | 'quote' | 'receipt'
let dgEditId = null;        // documents row id being edited, or null = create
let dgQuoteItems = [];      // [{description, qty, unitPrice}] while editing a quote
let dgTitleAuto = true;     // true while the title field still tracks the auto default
let dgLastPreviewHtml = '';

// Internal fallback only — client-visible titles come from dgTypeLabel()
// below, which localizes at generation time (Pass E, 2026-07-17).
const DG_TYPE_LABEL = { contract: 'Contract', nda: 'NDA', quote: 'Quote', receipt: 'Receipt' };
function dgTypeLabel(type) {
  const key = 'doc_title_' + type;
  const label = (typeof t === 'function') ? t(key) : key;
  return label === key ? (DG_TYPE_LABEL[type] || type) : label;
}
// Client-visible document dates. Thai business paperwork conventionally uses
// Buddhist-Era years (พ.ศ. = ค.ศ. + 543), so in Thai mode a stored
// 'YYYY-MM-DD' renders as e.g. '17 ก.ค. 2569'; English mode returns the
// stored string unchanged so existing EN documents stay byte-identical.
// Deliberately local to docgen.js — internal UI dates (fmtDate in app.js)
// keep their CE convention; only the paperwork handed to a Thai client
// follows Thai-document norms.
const DG_TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function docDate(iso) {
  if (!iso) return iso;
  const lang = (typeof curLang === 'function') ? curLang() : 'en';
  if (lang !== 'th') return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${DG_TH_MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[1], 10) + 543}`;
}
const DG_TYPE_ICON  = { contract: '📄', nda: '🔒', quote: '💬', receipt: '🧾' };
// Referable running numbers (shared nextDocNumber() from app.js, same scheme
// as invoices.js's own "INV-2026-0001" numbers) — contract/nda don't get one,
// they aren't the kind of document a client would need to "reference" later.
const DG_NUMBER_PREFIX = { quote: 'QUO', receipt: 'REC' };

// ─── entry point ────────────────────────────────────────────────────────
function renderDocgen() {
  ensureDocgenUI();
  const el = document.getElementById('docgen-body');
  if (!el) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  dbAll('documents').then(all => {
    const docs = all.filter(d => d.uid === uid)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    el.innerHTML = dgListHTML(docs);
  }).catch(err => {
    console.error('renderDocgen', err);
    el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load documents.</p></div>';
  });
}
window.renderDocgen = renderDocgen;

function dgListHTML(docs) {
  let h = '<div class="section-title">New document</div>';
  h += '<div class="dg-tpl-grid">'
    + '<button type="button" class="dg-tpl-btn" onclick="openGenerateForm(\'contract\')"><span class="dg-tpl-ico">📄</span><span class="dg-tpl-name">Contract</span></button>'
    + '<button type="button" class="dg-tpl-btn" onclick="openGenerateForm(\'nda\')"><span class="dg-tpl-ico">🔒</span><span class="dg-tpl-name">NDA</span></button>'
    + '<button type="button" class="dg-tpl-btn" onclick="openGenerateForm(\'quote\')"><span class="dg-tpl-ico">💬</span><span class="dg-tpl-name">Quote</span></button>'
    + '<button type="button" class="dg-tpl-btn" onclick="openGenerateForm(\'receipt\')"><span class="dg-tpl-ico">🧾</span><span class="dg-tpl-name">Receipt</span></button>'
    + '</div>';
  h += '<div class="section-title">Tools</div>';
  h += '<div class="dg-tool-grid">'
    + '<button type="button" class="dg-tool-btn" onclick="switchScreen(\'tax\')"><span class="dg-tool-ico">🧮</span><span class="dg-tool-name">Tax calculator</span></button>'
    + '</div>';
  h += '<div class="section-title">Saved documents</div>';
  if (!docs.length) {
    h += '<div class="empty"><div class="empty-icon">🗂️</div><p>No documents yet</p><span>Generate a contract, NDA, quote, or receipt above.</span></div>';
  } else {
    h += '<div class="list-card">' + docs.map(dgRowHTML).join('') + '</div>';
  }
  return h;
}

function dgRowHTML(d) {
  const ico = DG_TYPE_ICON[d.type] || '📄';
  const label = DG_TYPE_LABEL[d.type] || d.type;
  const sub = (d.number ? htmlEsc(d.number) + ' · ' : '')
    + (d.clientName ? htmlEsc(d.clientName) : 'No client') + ' · ' + htmlEsc(d.issueDate || '');
  const invoicedChip = (d.type === 'quote' && d.fields && d.fields.convertedToInvoice)
    ? '<span class="dg-chip" style="background:var(--brand);color:#fff;margin-left:4px">✓ Invoiced</span>' : '';
  return '<div class="list-row" tabindex="0" role="button" onclick="viewDocument(' + d.id + ')"'
    + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewDocument(' + d.id + ');}">'
    + '<div class="list-icon">' + ico + '</div>'
    + '<div class="list-main"><div class="list-title">' + htmlEsc(d.title || label) + '</div>'
    + '<div class="list-sub">' + sub + '</div></div>'
    + '<div class="list-right"><span class="dg-chip">' + label + '</span>' + invoicedChip + '</div>'
    + '</div>';
}

// ─── one-time DOM/style injection ──────────────────────────────────────
function ensureDocgenUI() {
  if (document.getElementById('dg-style')) return;

  const st = document.createElement('style');
  st.id = 'dg-style';
  st.textContent = `
    .dg-tpl-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:0 0 20px;}
    .dg-tpl-btn{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 10px;
      border-radius:var(--radius-sm);border:1.5px solid var(--border);background:var(--card);
      cursor:pointer;font-family:inherit;}
    .dg-tpl-btn:active{background:var(--brand-tint);border-color:var(--brand);}
    .dg-tpl-btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
    .dg-tool-grid{display:grid;grid-template-columns:1fr;gap:10px;margin:0 0 20px;}
    .dg-tool-btn{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px;padding:14px 16px;
      border-radius:var(--radius-sm);border:1.5px solid var(--border);background:var(--card);
      cursor:pointer;font-family:inherit;width:100%;}
    .dg-tool-btn:active{background:var(--brand-tint);border-color:var(--brand);}
    .dg-tool-btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
    .dg-tool-ico{font-size:20px;}
    .dg-tool-name{font-size:13px;font-weight:700;color:var(--text);}
    .dg-tpl-ico{font-size:24px;}
    .dg-tpl-name{font-size:13px;font-weight:700;color:var(--text);}
    .dg-chip{display:inline-block;padding:3px 9px;border-radius:9px;font-size:11px;font-weight:700;
      background:var(--brand-tint);color:var(--brand);}
    .dg-client-info{margin:0 0 14px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);
      border-radius:var(--radius-sm);font-size:12px;color:var(--text2);line-height:1.6;display:none;}
    .dg-client-info b{color:var(--text);}
    .dg-line-row{display:grid;grid-template-columns:1fr 56px 84px 26px;gap:6px;padding:8px 16px;
      border-bottom:0.5px solid var(--border);align-items:center;}
    .dg-line-row:last-child{border-bottom:none;}
    .dg-line-row input{width:100%;border:1px solid var(--border);border-radius:7px;padding:8px 7px;
      font-size:13px;font-family:inherit;background:var(--card);color:var(--text);}
    .dg-line-row input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand);border-color:var(--brand);}
    .dg-line-rm{background:none;border:none;color:var(--overdue);font-size:18px;cursor:pointer;line-height:1;
      padding:6px;}
    .dg-line-rm:focus-visible{outline:2px solid var(--overdue);outline-offset:1px;}
    .dg-add-row{margin:10px 16px;padding:10px;border:1.5px dashed var(--border);border-radius:var(--radius-sm);
      background:none;color:var(--brand);font-weight:700;font-size:13px;width:calc(100% - 32px);cursor:pointer;
      font-family:inherit;}
    .dg-add-row:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
    .dg-quote-total-line{text-align:right;padding:10px 16px;font-weight:800;font-size:15px;color:var(--text);}
    .dg-preview-wrap{margin:4px 16px 16px;}
    .dg-preview{padding:18px;background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);
      color:#111;font-size:13px;line-height:1.7;}
    .dg-preview .dg-doc h1{font-size:18px;margin-bottom:6px;color:#111;}
    .dg-preview .dg-doc h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 6px;color:#333;}
    .dg-preview .dg-doc p{margin:0 0 8px;}
    .dg-preview .dg-doc .dg-meta{color:#666;font-size:12px;margin-bottom:14px;}
    .dg-preview .dg-doc table{width:100%;border-collapse:collapse;margin:8px 0;}
    .dg-preview .dg-doc th,.dg-preview .dg-doc td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;font-size:12px;}
    .dg-preview .dg-doc ul{margin:0 0 8px 18px;}
    .dg-sign-row{display:flex;justify-content:space-between;gap:20px;margin-top:30px;font-size:12px;color:#111;}
    .dg-actions{display:flex;gap:8px;margin:10px 0 0;}
    .dg-btn-secondary{flex:1;padding:12px;border-radius:var(--radius-sm);border:1.5px solid var(--brand);
      background:none;color:var(--brand);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;}
    .dg-btn-secondary:active{background:var(--brand-tint);}
    .dg-btn-secondary:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
    .dg-view-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 16px 10px;}
    #docgen-print-root{display:none;}
    @media print{
      body.dg-printing > *:not(#docgen-print-root){display:none !important;}
      body.dg-printing #docgen-print-root{display:block !important;position:static;margin:0;padding:28px;background:#fff;}
      body.dg-printing #docgen-print-root, body.dg-printing #docgen-print-root *{color:#000 !important;}
      body.dg-printing #docgen-print-root .dg-doc h1{font-size:20px;}
    }
  `;
  document.head.appendChild(st);

  const host = document.createElement('div');
  host.innerHTML = dgGenerateModalHTML() + dgViewModalHTML();
  while (host.firstChild) document.body.appendChild(host.firstChild);

  const printRoot = document.createElement('div');
  printRoot.id = 'docgen-print-root';
  document.body.appendChild(printRoot);
}

function dgGenerateModalHTML() {
  return `
  <div class="modal-overlay" id="dg-modal" onclick="if(event.target===this) closeDgModal()">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <div class="modal-title" id="dg-modal-title">New document</div>

      <div class="form-section" id="dg-number-row" style="display:none">
        <div class="field"><label for="dg-number">Reference no.</label>
          <input type="text" id="dg-number" readonly disabled style="color:var(--text3)"></div>
      </div>

      <div class="form-section">
        <div class="field">
          <label for="dg-client">Customer</label>
          <select id="dg-client" onchange="onDgClientChange()"></select>
        </div>
        <div class="field">
          <label for="dg-client-name">Client / company name</label>
          <input type="text" id="dg-client-name" placeholder="Client name">
        </div>
      </div>
      <div class="dg-client-info" id="dg-client-info" style="margin:0 16px 14px"></div>

      <div class="form-section">
        <div class="field">
          <label for="dg-title">Document title</label>
          <input type="text" id="dg-title" oninput="dgTitleAuto=false" placeholder="Title">
        </div>
        <div class="field">
          <label for="dg-issue-date">Issue date</label>
          <input type="date" id="dg-issue-date">
        </div>
      </div>

      <div class="form-section" id="dg-fields-contract">
        <div class="form-header">Contract details</div>
        <div class="field"><label for="dg-c-deliverables">Deliverables</label>
          <textarea id="dg-c-deliverables" rows="3" placeholder="What you will deliver…"></textarea></div>
        <div class="form-row">
          <div class="field-half"><label for="dg-c-fee">Fee</label>
            <input type="number" id="dg-c-fee" class="tnum" min="0" step="any" inputmode="decimal" placeholder="0"></div>
          <div class="field-half"></div>
        </div>
        <div class="form-row">
          <div class="field-half"><label for="dg-c-start">Start date</label><input type="date" id="dg-c-start"></div>
          <div class="field-half"><label for="dg-c-end">End date</label><input type="date" id="dg-c-end"></div>
        </div>
        <div class="field"><label for="dg-c-usage">Usage rights / licensing (optional)</label>
          <textarea id="dg-c-usage" rows="2" placeholder="e.g. Client may use delivered photos for social media and web use…"></textarea></div>
        <div class="field"><label for="dg-c-terms">Additional terms (optional)</label>
          <textarea id="dg-c-terms" rows="2" placeholder="Anything else to include…"></textarea></div>
      </div>

      <div class="form-section" id="dg-fields-nda">
        <div class="form-header">NDA details</div>
        <div class="field"><label for="dg-n-effective">Effective date</label><input type="date" id="dg-n-effective"></div>
        <div class="field"><label for="dg-n-duration">Duration (months)</label>
          <input type="number" id="dg-n-duration" class="tnum" min="0" step="1" inputmode="numeric" placeholder="12"></div>
        <div class="field"><label for="dg-n-notes">Purpose / notes (optional)</label>
          <textarea id="dg-n-notes" rows="2" placeholder="Context for the disclosure…"></textarea></div>
      </div>

      <div class="form-section" id="dg-fields-quote">
        <div class="form-header">Quote details</div>
        <div class="field"><label for="dg-q-valid">Valid until</label><input type="date" id="dg-q-valid"></div>
        <div id="dg-q-items-wrap"></div>
      </div>
      <button type="button" class="dg-add-row" id="dg-fields-quote-add" onclick="dgAddLine()">+ Add line item</button>
      <div class="dg-quote-total-line" id="dg-fields-quote-total-wrap">Subtotal: <span id="dg-q-subtotal">${money(0)}</span></div>
      <div class="form-section" id="dg-fields-quote-notes-wrap">
        <div class="field"><label for="dg-q-notes">Notes (optional)</label>
          <textarea id="dg-q-notes" rows="2" placeholder="Anything else the client should know…"></textarea></div>
      </div>

      <div class="form-section" id="dg-fields-receipt">
        <div class="form-header">Receipt details</div>
        <div class="form-row">
          <div class="field-half"><label for="dg-r-amount">Amount received</label>
            <input type="number" id="dg-r-amount" class="tnum" min="0" step="any" inputmode="decimal" placeholder="0"></div>
          <div class="field-half"><label for="dg-r-date">Payment date</label><input type="date" id="dg-r-date"></div>
        </div>
        <div class="field"><label for="dg-r-method">Payment method</label>
          <input type="text" id="dg-r-method" placeholder="e.g. Cash, bank transfer, PromptPay"></div>
        <div class="field"><label for="dg-r-ref">Reference (optional)</label>
          <input type="text" id="dg-r-ref" placeholder="e.g. the invoice number this pays off"></div>
        <div class="field"><label for="dg-r-notes">Notes (optional)</label>
          <textarea id="dg-r-notes" rows="2" placeholder="Anything else to include…"></textarea></div>
      </div>

      <div class="dg-preview-wrap" id="dg-preview-wrap" style="display:none"></div>

      <button type="button" class="dg-btn-secondary" style="margin:0 16px 10px;width:calc(100% - 32px)" onclick="previewCurrentForm()">Preview document</button>
      <button type="button" class="btn-submit" onclick="saveDocumentFromForm()">Save document</button>
      <button type="button" class="btn-danger" style="border-color:var(--border-mid);color:var(--text3)" onclick="closeDgModal()">Cancel</button>
    </div>
  </div>`;
}

function dgViewModalHTML() {
  return `
  <div class="modal-overlay" id="dg-view-modal" onclick="if(event.target===this) closeDgViewModal()">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <div class="modal-title" id="dg-view-title">Document</div>
      <div id="dg-view-content" style="margin:0 16px 16px"></div>
      <div id="dg-view-convert"></div>
      <div class="dg-view-actions">
        <button type="button" class="dg-btn-secondary" onclick="editSavedDocument()">Edit</button>
        <button type="button" class="dg-btn-secondary" onclick="printSavedDocument()">Export / Print</button>
      </div>
      <button type="button" class="btn-danger" onclick="deleteSavedDocument()">Delete document</button>
      <button type="button" class="btn-danger" style="border-color:var(--border-mid);color:var(--text3)" onclick="closeDgViewModal()">Close</button>
    </div>
  </div>`;
}

// ─── generate / edit form ───────────────────────────────────────────────
function openGenerateForm(type, rec) {
  ensureDocgenUI();
  dgCurrentType = type;
  dgEditId = rec ? rec.id : null;
  // Clear any stale pipeline linkage; openQuoteForJob (app.js) re-sets it after this call.
  window.__pendingQuoteJobId = null;
  dgLastPreviewHtml = '';
  dgClearErrors();

  const wrap = document.getElementById('dg-preview-wrap');
  wrap.style.display = 'none';
  wrap.innerHTML = '';

  document.getElementById('dg-modal-title').textContent = (rec ? 'Edit ' : 'New ') + DG_TYPE_LABEL[type];

  ['contract', 'nda', 'quote', 'receipt'].forEach(t => {
    const grp = document.getElementById('dg-fields-' + t);
    if (grp) grp.style.display = (t === type) ? '' : 'none';
  });
  const addBtn = document.getElementById('dg-fields-quote-add');
  const totalWrap = document.getElementById('dg-fields-quote-total-wrap');
  const notesWrap = document.getElementById('dg-fields-quote-notes-wrap');
  if (addBtn) addBtn.style.display = (type === 'quote') ? '' : 'none';
  if (totalWrap) totalWrap.style.display = (type === 'quote') ? '' : 'none';
  if (notesWrap) notesWrap.style.display = (type === 'quote') ? '' : 'none';

  // Reference number: read-only, only shown for the types that get one.
  const numberRow = document.getElementById('dg-number-row');
  if (numberRow) numberRow.style.display = DG_NUMBER_PREFIX[type] ? '' : 'none';
  setVal('dg-number', DG_NUMBER_PREFIX[type] ? ((rec && rec.number) || 'assigned on save') : '');

  const f = (rec && rec.fields) || {};

  dgTitleAuto = !rec;
  populateClientSelect(f.clientId != null ? f.clientId : null);
  document.getElementById('dg-client-name').value = rec ? (rec.clientName || '') : '';
  onDgClientChange();
  if (!f.clientId) document.getElementById('dg-client-name').value = (rec && rec.clientName) || '';

  document.getElementById('dg-title').value = rec ? (rec.title || '') : defaultTitle(type, document.getElementById('dg-client-name').value);
  document.getElementById('dg-issue-date').value = (rec && rec.issueDate) || todayISO();

  if (type === 'contract') {
    setVal('dg-c-deliverables', f.deliverables || '');
    setVal('dg-c-fee', f.fee != null ? f.fee : '');
    setVal('dg-c-start', f.startDate || todayISO());
    setVal('dg-c-end', f.endDate || '');
    setVal('dg-c-usage', f.usageRights || '');
    setVal('dg-c-terms', f.terms || '');
    if (!rec) applyPersonaDefaultsForContract();
  } else if (type === 'nda') {
    setVal('dg-n-effective', f.effectiveDate || todayISO());
    setVal('dg-n-duration', f.durationMonths != null ? f.durationMonths : 12);
    setVal('dg-n-notes', f.notes || '');
  } else if (type === 'quote') {
    setVal('dg-q-valid', f.validUntil || '');
    setVal('dg-q-notes', f.notes || '');
    dgQuoteItems = (f.lineItems && f.lineItems.length)
      ? f.lineItems.map(li => ({ description: li.description || '', qty: li.qty != null ? li.qty : 1, unitPrice: li.unitPrice != null ? li.unitPrice : 0 }))
      : [{ description: '', qty: 1, unitPrice: 0 }];
    renderQuoteRows();
  } else if (type === 'receipt') {
    setVal('dg-r-amount', f.amount != null ? f.amount : '');
    setVal('dg-r-date', f.paymentDate || todayISO());
    setVal('dg-r-method', f.method || '');
    setVal('dg-r-ref', f.reference || '');
    setVal('dg-r-notes', f.notes || '');
  }

  document.getElementById('dg-modal').classList.add('open');
}
window.openGenerateForm = openGenerateForm;

function setVal(id, v) { const e = document.getElementById(id); if (e) e.value = v; }

function defaultTitle(type, clientName) {
  const label = DG_TYPE_LABEL[type] || 'Document';
  return clientName ? (label + ' — ' + clientName) : label;
}

function populateClientSelect(selectedId) {
  const sel = document.getElementById('dg-client');
  sel.innerHTML = '<option value="">— Custom / no client on file —</option>' +
    customers.map(c => '<option value="' + c.id + '">' + htmlEsc(c.name || 'Unnamed') + '</option>').join('');
  sel.value = selectedId != null ? String(selectedId) : '';
}

function onDgClientChange() {
  const sel = document.getElementById('dg-client');
  const nameInput = document.getElementById('dg-client-name');
  const infoBox = document.getElementById('dg-client-info');
  const val = sel.value;
  if (!val) {
    infoBox.style.display = 'none';
    infoBox.innerHTML = '';
    if (dgTitleAuto) document.getElementById('dg-title').value = defaultTitle(dgCurrentType, nameInput.value.trim());
    return;
  }
  const c = customers.find(x => String(x.id) === val);
  if (!c) { infoBox.style.display = 'none'; return; }
  nameInput.value = c.name || '';
  const bits = [];
  if (c.company) bits.push('<b>Company:</b> ' + htmlEsc(c.company));
  if (c.billingAddress) bits.push('<b>Billing:</b> ' + htmlEsc(c.billingAddress));
  if (c.taxId) bits.push('<b>Tax ID:</b> ' + htmlEsc(c.taxId));
  if (c.phone) bits.push('<b>Phone:</b> ' + htmlEsc(c.phone));
  if (c.email) bits.push('<b>Email:</b> ' + htmlEsc(c.email));
  infoBox.innerHTML = bits.length ? bits.join('<br>') : '<i>No extra billing details on file for this customer.</i>';
  infoBox.style.display = 'block';
  if (dgTitleAuto) document.getElementById('dg-title').value = defaultTitle(dgCurrentType, nameInput.value.trim());
  if (dgCurrentType === 'contract' && dgEditId === null) applyPersonaDefaultsForContract();
}
window.onDgClientChange = onDgClientChange;

// Prefill the contract's usage-rights field from the customer's saved value, if any.
function applyPersonaDefaultsForContract() {
  const sel = document.getElementById('dg-client');
  const c = sel.value ? customers.find(x => String(x.id) === sel.value) : null;
  const usageEl = document.getElementById('dg-c-usage');
  if (usageEl && !usageEl.value && c && c.usageRights) usageEl.value = c.usageRights;
}

// ─── quote line items ────────────────────────────────────────────────────
function renderQuoteRows() {
  const wrap = document.getElementById('dg-q-items-wrap');
  if (!wrap) return;
  wrap.innerHTML = dgQuoteItems.map((li, i) =>
    '<div class="dg-line-row">'
    + '<input type="text" placeholder="Description" value="' + attrEsc(li.description || '') + '" oninput="dgQuoteItems[' + i + '].description=this.value">'
    + '<input type="number" min="0" step="any" inputmode="decimal" placeholder="Qty" value="' + (li.qty != null ? li.qty : '') + '" oninput="dgQuoteItems[' + i + '].qty=parseFloat(this.value)||0;dgUpdateQuoteTotal();">'
    + '<input type="number" min="0" step="any" inputmode="decimal" class="tnum" placeholder="Unit price" value="' + (li.unitPrice != null ? li.unitPrice : '') + '" oninput="dgQuoteItems[' + i + '].unitPrice=parseFloat(this.value)||0;dgUpdateQuoteTotal();">'
    + '<button type="button" class="dg-line-rm" aria-label="Remove line item" onclick="dgRemoveLine(' + i + ')">✕</button>'
    + '</div>'
  ).join('');
  dgUpdateQuoteTotal();
}

function dgAddLine() {
  dgQuoteItems.push({ description: '', qty: 1, unitPrice: 0 });
  renderQuoteRows();
}
window.dgAddLine = dgAddLine;

function dgRemoveLine(i) {
  dgQuoteItems.splice(i, 1);
  if (!dgQuoteItems.length) dgQuoteItems.push({ description: '', qty: 1, unitPrice: 0 });
  renderQuoteRows();
}
window.dgRemoveLine = dgRemoveLine;

function dgUpdateQuoteTotal() {
  const subtotal = dgQuoteItems.reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.unitPrice) || 0), 0);
  const el = document.getElementById('dg-q-subtotal');
  if (el) el.textContent = money(subtotal);
  return subtotal;
}
window.dgUpdateQuoteTotal = dgUpdateQuoteTotal;

// ─── validation ──────────────────────────────────────────────────────────
function dgClearErrors() {
  const modal = document.getElementById('dg-modal');
  if (!modal) return;
  modal.querySelectorAll('.field-invalid').forEach(e => e.classList.remove('field-invalid'));
  modal.querySelectorAll('.field-err').forEach(e => e.remove());
}

function dgMarkError(inputId, msg) {
  const input = document.getElementById(inputId);
  if (!input) { toast(msg); return; }
  const wrap = input.closest('.field, .field-half');
  if (!wrap) { toast(msg); return; }
  wrap.classList.add('field-invalid');
  const span = document.createElement('span');
  span.className = 'field-err';
  span.textContent = msg;
  wrap.appendChild(span);
}

// Reads + validates the open form. Returns a draft record or null (and
// marks inline errors) if invalid.
function buildDocFromForm() {
  dgClearErrors();
  let ok = true;

  const sel = document.getElementById('dg-client');
  const clientId = sel.value ? parseInt(sel.value, 10) : null;
  const clientName = (document.getElementById('dg-client-name').value || '').trim();
  if (!clientName) { dgMarkError('dg-client-name', 'Client name is required.'); ok = false; }

  const title = (document.getElementById('dg-title').value || '').trim() || defaultTitle(dgCurrentType, clientName);
  const issueDate = document.getElementById('dg-issue-date').value || todayISO();
  const c = clientId != null ? customers.find(x => x.id === clientId) : null;

  const fields = { clientId, clientName };
  if (c) {
    fields.company = c.company || '';
    fields.billingAddress = c.billingAddress || '';
    fields.taxId = c.taxId || '';
    fields.healthNotes = c.healthNotes || '';
    fields.allergies = c.allergies || '';
    fields.goals = c.goals || '';
  }

  if (dgCurrentType === 'contract') {
    const deliverables = (document.getElementById('dg-c-deliverables').value || '').trim();
    const fee = parseFloat(document.getElementById('dg-c-fee').value) || 0;
    const startDate = document.getElementById('dg-c-start').value || '';
    const endDate = document.getElementById('dg-c-end').value || '';
    const usageRights = (document.getElementById('dg-c-usage').value || '').trim();
    const terms = (document.getElementById('dg-c-terms').value || '').trim();
    if (!deliverables) { dgMarkError('dg-c-deliverables', 'Describe the deliverables.'); ok = false; }
    Object.assign(fields, { deliverables, fee, startDate, endDate, usageRights, terms });
  } else if (dgCurrentType === 'nda') {
    const effectiveDate = document.getElementById('dg-n-effective').value || todayISO();
    const durationMonths = parseFloat(document.getElementById('dg-n-duration').value) || 0;
    const notes = (document.getElementById('dg-n-notes').value || '').trim();
    if (durationMonths <= 0) { dgMarkError('dg-n-duration', 'Enter a duration greater than 0.'); ok = false; }
    Object.assign(fields, { effectiveDate, durationMonths, notes });
  } else if (dgCurrentType === 'quote') {
    const validUntil = document.getElementById('dg-q-valid').value || '';
    const notes = (document.getElementById('dg-q-notes').value || '').trim();
    const lineItems = dgQuoteItems
      .filter(li => (li.description || '').trim() && (Number(li.qty) || 0) > 0)
      .map(li => ({ description: (li.description || '').trim(), qty: Number(li.qty) || 0, unitPrice: Number(li.unitPrice) || 0 }));
    if (!lineItems.length) { toast('Add at least one line item with a description and quantity.'); ok = false; }
    const subtotal = lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0);
    Object.assign(fields, { validUntil, notes, lineItems, subtotal });
  } else if (dgCurrentType === 'receipt') {
    const amount = parseFloat(document.getElementById('dg-r-amount').value) || 0;
    const paymentDate = document.getElementById('dg-r-date').value || todayISO();
    const method = (document.getElementById('dg-r-method').value || '').trim();
    const reference = (document.getElementById('dg-r-ref').value || '').trim();
    const notes = (document.getElementById('dg-r-notes').value || '').trim();
    if (amount <= 0) { dgMarkError('dg-r-amount', 'Enter the amount received.'); ok = false; }
    Object.assign(fields, { amount, paymentDate, method, reference, notes });
  }

  if (!ok) return null;
  return { type: dgCurrentType, title, clientId, clientName, issueDate, fields };
}

// ─── document body rendering (used for preview, save snapshot, print) ──
function esc(s) { return htmlEsc(s || ''); }

function nlToP(s) {
  const t = htmlEsc(s || '').trim();
  if (!t) return '<p>—</p>';
  return t.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
}

function freelancerName() {
  return (typeof sellerBusinessName === 'function')
    ? sellerBusinessName()
    : ((currentUser && (currentUser.firstName || currentUser.username)) || 'Freelancer');
}
// Seller line shown at the top of every document: name always (falls back to
// the account's display name), tax ID/address only when filled in under
// Settings > Business info — never required.
function sellerInfoLine(fname) {
  const bits = [fname];
  if (typeof settings !== 'undefined' && settings) {
    if (settings.sellerAddress) bits.push(esc(settings.sellerAddress));
    if (settings.sellerTaxId) bits.push('Tax ID: ' + esc(settings.sellerTaxId));
  }
  return '<p class="dg-meta">' + bits.join(' · ') + '</p>';
}
// Phase 1, Pro+: renders nothing at all (not even a broken-image gap) for
// any account without the docBranding entitlement, or that never uploaded
// one — sellerLogoDataUrl() (app.js) itself re-checks the plan gate at
// render time, not just at upload time, so a downgrade quietly stops new
// documents from showing the logo without deleting the stored image.
function sellerLogoHtml() {
  const url = (typeof sellerLogoDataUrl === 'function') ? sellerLogoDataUrl() : '';
  return url ? '<img src="' + attrEsc(url) + '" alt="" style="max-height:56px;max-width:180px;object-fit:contain;margin-bottom:8px">' : '';
}
// Optional client billing address/tax ID, snapshotted from the customer
// profile onto the document's fields when a customer was selected.
function clientInfoLine(f) {
  const bits = [];
  if (f.billingAddress) bits.push(esc(f.billingAddress));
  if (f.taxId) bits.push(esc(t('doc_taxid_short')) + ' ' + esc(f.taxId));
  return bits.length ? '<p class="dg-meta">' + bits.join(' · ') + '</p>' : '';
}

function signatureBlock(fname, cname) {
  const sig = esc(t('doc_signature_label')) + ' ______________________<br>' + esc(t('doc_date_label')) + ' __________';
  return '<div class="dg-sign-row">'
    + '<div>' + fname + ' ' + esc(t('doc_provider_suffix')) + '<br>' + sig + '</div>'
    + '<div>' + cname + ' ' + esc(t('doc_client_suffix')) + '<br>' + sig + '</div>'
    + '</div>';
}

// Pass E (2026-07-17): every client-visible string below renders through
// t() — the paperwork this Thai-first product hands to Thai clients was its
// least Thai surface. A document is rendered in the app's CURRENT language
// at generation time (t() resolves at call time); there is deliberately no
// per-document language picker yet — flip the app language, regenerate.
// Dates go through docDate() (Buddhist-Era in Thai mode, see above).
function buildDocHtml(rec) {
  const f = rec.fields || {};
  const fname = esc(freelancerName() || t('doc_freelancer_fallback'));
  const cname = esc(rec.clientName || t('doc_client_fallback'));
  const title = rec.title && !Object.values(DG_TYPE_LABEL).includes(rec.title)
    ? rec.title              // user-customized title — keep verbatim
    : dgTypeLabel(rec.type); // stock title — localize at render time
  let body = '<div class="dg-doc">' + sellerLogoHtml() + '<h1>' + esc(title) + '</h1>' + sellerInfoLine(fname);

  if (rec.type === 'contract') {
    body += '<p class="dg-meta">' + esc(t('doc_issue_date_label')) + ' ' + esc(docDate(rec.issueDate)) + '</p>';
    body += '<p>' + esc(t('doc_contract_intro'))
      .replace('{date}', '<b>' + esc(docDate(rec.issueDate)) + '</b>')
      .replace('{provider}', '<b>' + fname + '</b>')
      .replace('{client}', '<b>' + cname + '</b>') + '</p>';
    if (f.company) body += '<p><b>' + esc(t('doc_client_company_label')) + '</b> ' + esc(f.company) + '</p>';
    if (f.billingAddress) body += '<p><b>' + esc(t('doc_billing_address_label')) + '</b> ' + esc(f.billingAddress) + '</p>';
    if (f.taxId) body += '<p><b>' + esc(t('doc_client_taxid_label')) + '</b> ' + esc(f.taxId) + '</p>';
    body += '<h3>' + esc(t('doc_deliverables_header')) + '</h3>' + nlToP(f.deliverables);
    body += '<h3>' + esc(t('doc_fee_header')) + '</h3><p>' + esc(t('doc_total_fee_label')) + ' <b>' + money(f.fee || 0) + '</b></p>';
    body += '<h3>' + esc(t('doc_term_header')) + '</h3><p>' + (f.startDate ? esc(docDate(f.startDate)) : '—') + ' ' + esc(t('doc_date_range_sep')) + ' ' + (f.endDate ? esc(docDate(f.endDate)) : '—') + '</p>';
    if (f.usageRights) body += '<h3>' + esc(t('doc_usage_rights_header')) + '</h3>' + nlToP(f.usageRights);
    if (f.healthNotes || f.allergies || f.goals) {
      body += '<h3>' + esc(t('doc_health_waiver_header')) + '</h3>'
        + '<p>' + esc(t('doc_health_waiver_body')) + '</p><ul>';
      if (f.goals) body += '<li><b>' + esc(t('doc_goals_label')) + '</b> ' + esc(f.goals) + '</li>';
      if (f.healthNotes) body += '<li><b>' + esc(t('doc_health_notes_label')) + '</b> ' + esc(f.healthNotes) + '</li>';
      if (f.allergies) body += '<li><b>' + esc(t('doc_allergies_label')) + '</b> ' + esc(f.allergies) + '</li>';
      body += '</ul>';
    }
    body += '<h3>' + esc(t('doc_additional_terms_header')) + '</h3>' + nlToP(f.terms);
    body += signatureBlock(fname, cname);
  } else if (rec.type === 'nda') {
    const eff = esc(docDate(f.effectiveDate || rec.issueDate));
    body += '<p class="dg-meta">' + esc(t('doc_effective_date_label')) + ' ' + eff + '</p>';
    body += '<p>' + esc(t('doc_nda_intro'))
      .replace('{provider}', '<b>' + fname + '</b>')
      .replace('{client}', '<b>' + cname + '</b>')
      .replace('{date}', '<b>' + eff + '</b>') + '</p>';
    body += '<h3>' + esc(t('doc_nda_h1_title')) + '</h3><p>' + esc(t('doc_nda_h1_body')) + '</p>';
    body += '<h3>' + esc(t('doc_nda_h2_title')) + '</h3><p>' + esc(t('doc_nda_h2_body')) + '</p>';
    body += '<h3>' + esc(t('doc_nda_h3_title')) + '</h3><p>' + esc(t('doc_nda_h3_body')) + '</p>';
    body += '<h3>' + esc(t('doc_nda_h4_title')) + '</h3><p>' + esc(t('doc_nda_h4_body'))
      .replace('{duration}', '<b>' + esc(f.durationMonths) + ' ' + esc(t('doc_month_unit')) + '</b>') + '</p>';
    body += '<h3>' + esc(t('doc_nda_h5_title')) + '</h3>' + nlToP(f.notes);
    body += signatureBlock(fname, cname);
  } else if (rec.type === 'quote') {
    body += '<p class="dg-meta">' + (rec.number ? esc(t('doc_quote_number_prefix')) + esc(rec.number) + ' · ' : '') + esc(t('doc_issue_date_label')) + ' ' + esc(docDate(rec.issueDate)) + (f.validUntil ? ' · ' + esc(t('doc_valid_until_label')) + ' ' + esc(docDate(f.validUntil)) : '') + '</p>';
    body += '<p><b>' + esc(t('doc_prepared_for_label')) + '</b> ' + cname + (f.company ? ' (' + esc(f.company) + ')' : '') + '</p>';
    body += clientInfoLine(f);
    body += '<table><thead><tr><th>' + esc(t('doc_field_description')) + '</th><th>' + esc(t('doc_field_qty')) + '</th><th>' + esc(t('doc_field_unit_price')) + '</th><th>' + esc(t('doc_col_total')) + '</th></tr></thead><tbody>';
    (f.lineItems || []).forEach(li => {
      const qtyNum = Number(li.qty) || 0;
      const lineTotal = qtyNum * (Number(li.unitPrice) || 0);
      body += '<tr><td>' + esc(li.description) + '</td><td>' + fmt(qtyNum, qtyNum % 1 !== 0 ? 2 : 0) + '</td><td>' + money(li.unitPrice) + '</td><td>' + money(lineTotal) + '</td></tr>';
    });
    body += '</tbody></table>';
    body += '<p style="text-align:right;font-weight:800">' + esc(t('doc_subtotal_label')) + ' ' + money(f.subtotal || 0) + '</p>';
    if (f.notes) body += '<h3>' + esc(t('doc_notes_header')) + '</h3>' + nlToP(f.notes);
    body += '<p style="margin-top:16px">' + esc(t('doc_quote_footer')).replace('{date}', '<b>' + (f.validUntil ? esc(docDate(f.validUntil)) : '—') + '</b>') + '</p>';
  } else if (rec.type === 'receipt') {
    body += '<p class="dg-meta">' + (rec.number ? esc(t('doc_receipt_number_prefix')) + esc(rec.number) + ' · ' : '') + esc(t('doc_payment_date_label')) + ' ' + esc(docDate(f.paymentDate || rec.issueDate)) + '</p>';
    body += '<p><b>' + esc(t('doc_received_from_label')) + '</b> ' + cname + (f.company ? ' (' + esc(f.company) + ')' : '') + '</p>';
    body += clientInfoLine(f);
    body += '<h3>' + esc(t('doc_amount_received_header')) + '</h3><p><b>' + money(f.amount || 0) + '</b></p>';
    body += '<h3>' + esc(t('doc_payment_method_header')) + '</h3><p>' + (f.method ? esc(f.method) : '—') + '</p>';
    if (f.reference) body += '<h3>' + esc(t('doc_reference_header')) + '</h3><p>' + esc(f.reference) + '</p>';
    if (f.notes) body += '<h3>' + esc(t('doc_notes_header')) + '</h3>' + nlToP(f.notes);
    body += '<p style="margin-top:16px">' + esc(t('doc_receipt_footer')) + '</p>';
  }

  body += '</div>';
  return body;
}

// ─── preview / save / print (from the generate form) ────────────────────
function previewCurrentForm() {
  const draft = buildDocFromForm();
  if (!draft) { toast('Please fix the highlighted fields.'); return; }
  const html = buildDocHtml(draft);
  dgLastPreviewHtml = html;
  const wrap = document.getElementById('dg-preview-wrap');
  wrap.innerHTML = '<div class="dg-preview">' + html + '</div>'
    + '<div class="dg-actions"><button type="button" class="dg-btn-secondary" onclick="printDraftPreview()">Print preview</button></div>';
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.previewCurrentForm = previewCurrentForm;

function printDraftPreview() {
  if (!dgLastPreviewHtml) return;
  printDocument(dgLastPreviewHtml);
}
window.printDraftPreview = printDraftPreview;

async function saveDocumentFromForm() {
  const draft = buildDocFromForm();
  if (!draft) { toast('Please fix the highlighted fields.'); return; }
  const uid = isGuest ? 'guest' : currentUser.id;

  // Reference number: assigned once at creation, immutable on edit — same
  // rule invoices.js follows for its own "INV-2026-0001" numbers. Only the
  // types in DG_NUMBER_PREFIX get one (contract/nda don't).
  let number = null;
  const prefix = DG_NUMBER_PREFIX[draft.type];
  if (prefix) {
    if (dgEditId) {
      const existing = await dbGet('documents', dgEditId);
      number = (existing && existing.number) || null;
    } else {
      const sameType = (await dbAll('documents')).filter(d => d.uid === uid && d.type === draft.type);
      number = nextDocNumber(sameType, prefix);
    }
  }
  draft.number = number;   // baked into the rendered content snapshot below

  const content = buildDocHtml(draft);
  const rec = {
    uid,
    type: draft.type,
    title: draft.title,
    clientId: draft.clientId,
    clientName: draft.clientName,
    invoiceId: null,
    fields: draft.fields,
    content,
    number,
    issueDate: draft.issueDate,
    updatedAt: nowISO(),
  };
  try {
    const mirrorEnabled = !isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled();
    if (dgEditId) {
      const existing = await dbGet('documents', dgEditId);
      rec.id = dgEditId;
      rec.cuid = (existing && existing.cuid) || cuid();
      await dbPut('documents', rec);
      if (mirrorEnabled) SidekickBackend.mirrorDocumentSave(rec).catch(() => {});
      toast('Document updated.');
    } else {
      rec.cuid = cuid();
      const newId = await dbAdd('documents', rec);
      rec.id = newId;
      if (mirrorEnabled) SidekickBackend.mirrorDocumentSave(rec).catch(() => {});
      toast('Document saved.');
      // Engagement linking: a quote saved from the pipeline links back to its
      // session and advances the stage. Any other save leaves __pendingQuoteJobId unset.
      const pipelineJobId = (rec.type === 'quote' && window.__pendingQuoteJobId != null)
        ? window.__pendingQuoteJobId : null;
      if (pipelineJobId != null && typeof window.onEngagementQuoteCreated === 'function') {
        try { window.onEngagementQuoteCreated(newId, pipelineJobId); } catch (e) { /* non-fatal */ }
      }
      window.__pendingQuoteJobId = null;
    }
    closeDgModal();
    renderDocgen();
  } catch (err) {
    console.error('saveDocumentFromForm', err);
    toast('Could not save the document.');
  }
}
window.saveDocumentFromForm = saveDocumentFromForm;

function closeDgModal() {
  const m = document.getElementById('dg-modal');
  if (m) m.classList.remove('open');
}
window.closeDgModal = closeDgModal;

// ─── view / edit / delete a saved document ──────────────────────────────
async function viewDocument(id) {
  ensureDocgenUI();
  const rec = await dbGet('documents', id);
  if (!rec) { toast('Document not found.'); return; }
  document.getElementById('dg-view-title').textContent = (rec.number ? rec.number + ' — ' : '') + (rec.title || DG_TYPE_LABEL[rec.type] || 'Document');
  document.getElementById('dg-view-content').innerHTML = '<div class="dg-preview">' + (rec.content || '') + '</div>';
  document.getElementById('dg-view-modal').dataset.docId = String(rec.id);
  document.getElementById('dg-view-modal').classList.add('open');

  // Quotes only: offer a one-way "Convert to invoice" that pre-fills a new
  // invoice from the quote's client + line items (owned by invoices.js).
  // Once converted, marked so the same quote can't spawn duplicate invoices.
  const convertWrap = document.getElementById('dg-view-convert');
  if (convertWrap) {
    const f = rec.fields || {};
    if (rec.type === 'quote' && f.convertedToInvoice) {
      convertWrap.innerHTML = '<div style="margin:0 16px 12px;color:var(--brand);font-size:13px;font-weight:700">✓ Converted to invoice</div>';
    } else if (rec.type === 'quote' && typeof openInvoiceForm === 'function') {
      convertWrap.innerHTML = '<button type="button" class="btn-submit" style="margin:0 16px 12px;width:calc(100% - 32px)" onclick="convertQuoteToInvoice()">Convert to invoice</button>';
    } else {
      convertWrap.innerHTML = '';
    }
  }
}
window.viewDocument = viewDocument;

async function convertQuoteToInvoice() {
  const id = currentViewDocId();
  if (id == null) return;
  const rec = await dbGet('documents', id);
  if (!rec || rec.type !== 'quote') return;
  const f = rec.fields || {};
  try {
    rec.fields = { ...f, convertedToInvoice: true };
    rec.updatedAt = nowISO();
    await dbPut('documents', rec);
  } catch (err) {
    console.error('convertQuoteToInvoice', err);
  }
  closeDgViewModal();
  renderDocgen();
  if (typeof openInvoiceForm === 'function') {
    switchScreen('invoices');
    openInvoiceForm(null, { clientId: rec.clientId, clientName: rec.clientName, lineItems: f.lineItems || [] });
  } else {
    toast('Invoicing module not loaded');
  }
}
window.convertQuoteToInvoice = convertQuoteToInvoice;

function closeDgViewModal() {
  const m = document.getElementById('dg-view-modal');
  if (m) m.classList.remove('open');
}
window.closeDgViewModal = closeDgViewModal;

function currentViewDocId() {
  const m = document.getElementById('dg-view-modal');
  const raw = m && m.dataset.docId;
  return raw ? parseInt(raw, 10) : null;
}

async function printSavedDocument() {
  const id = currentViewDocId();
  if (id == null) return;
  const rec = await dbGet('documents', id);
  if (rec) printDocument(rec.content || '');
}
window.printSavedDocument = printSavedDocument;

async function editSavedDocument() {
  const id = currentViewDocId();
  if (id == null) return;
  const rec = await dbGet('documents', id);
  if (!rec) return;
  closeDgViewModal();
  openGenerateForm(rec.type, rec);
}
window.editSavedDocument = editSavedDocument;

async function deleteSavedDocument() {
  const id = currentViewDocId();
  if (id == null) return;
  if (!confirm('Delete this document? This cannot be undone.')) return;
  try {
    const prev = await dbGet('documents', id);
    await dbDel('documents', id);
    if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
      SidekickBackend.mirrorDocumentDelete(prev.cuid).catch(() => {});
    }
    closeDgViewModal();
    toast('Document deleted.');
    renderDocgen();
  } catch (err) {
    console.error('deleteSavedDocument', err);
    toast('Could not delete the document.');
  }
}
window.deleteSavedDocument = deleteSavedDocument;

// ─── print (Export/PDF) ──────────────────────────────────────────────────
function printDocument(html) {
  ensureDocgenUI();
  const root = document.getElementById('docgen-print-root');
  if (!root) return;
  root.innerHTML = html;
  // Page size is a Settings-wide choice (A4/A5), so it's set fresh per print
  // call rather than baked into ensureDocgenUI()'s one-time style block.
  let pageStyle = document.getElementById('dg-page-style');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'dg-page-style';
    document.head.appendChild(pageStyle);
  }
  pageStyle.textContent = `@media print{ ${docPageSizeCss()} }`;
  const cleanup = () => {
    document.body.classList.remove('dg-printing');
    window.removeEventListener('afterprint', cleanup);
  };
  document.body.classList.add('dg-printing');
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safety cleanup if afterprint never fires
  setTimeout(cleanup, 60000);
}
