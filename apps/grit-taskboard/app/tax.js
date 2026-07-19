/* Sidekick — tax.js  (M2 TAX ENGINE)
 *
 * OWNED BY the tax-engine agent. Fills #tax-body only. English-only inline
 * UI; does not touch app.js's I18N dict. Light-mode tokens only (consumes
 * the existing var(--...) design tokens from styles.css — no new colors).
 *
 * Public surface (kept per the M2 contract, exposed on window):
 *   - computeTax(subtotal, whtPct, vatPct) -> {vat, wht, clientPays, youReceive}
 *   - renderTax()  — fills #tax-body (empty container it owns)
 */
'use strict';

// ─── pure math ──────────────────────────────────────────────────────────
// Rounds to 2dp using an epsilon nudge to dodge classic FP artifacts
// (e.g. 1.005 * 100 landing on 100.49999999999999).
function taxRound2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// TH convention (contract): VAT and WHT are both computed on the pre-tax
// subtotal (the service base). clientPays = subtotal + vat (what the client
// transfers); youReceive = subtotal + vat - wht (client withholds WHT and
// remits it to the Revenue Department on your behalf). Pure function: no
// NaN/negative inputs can escape as NaN/negative outputs.
function computeTax(subtotal, whtPct, vatPct) {
  let s = Number(subtotal); if (!isFinite(s) || s < 0) s = 0;
  let w = Number(whtPct);   if (!isFinite(w) || w < 0) w = 0;
  let v = Number(vatPct);   if (!isFinite(v) || v < 0) v = 0;

  const vat = taxRound2(s * (v / 100));
  const wht = taxRound2(s * (w / 100));
  const clientPays = taxRound2(s + vat);
  const youReceive = taxRound2(clientPays - wht);
  return { vat, wht, clientPays, youReceive };
}
window.computeTax = computeTax;

// ─── calculator state (session-only; re-seeded from settings on first render) ──
const WHT_PRESETS = [0, 1, 2, 3, 5];
let taxState = null;

function taxDefaultState() {
  const whtDefault = (settings && settings.wht != null) ? Number(settings.wht) : 3;
  const vatDefault = (settings && settings.vat != null) ? Number(settings.vat) : 7;
  return {
    amount: '',
    whtPct: isFinite(whtDefault) ? whtDefault : 3,
    vatOn: vatDefault > 0,
    vatPct: isFinite(vatDefault) && vatDefault > 0 ? vatDefault : 7,
  };
}

function taxEnsureStyles() {
  if (document.getElementById('tax-styles')) return;
  const style = document.createElement('style');
  style.id = 'tax-styles';
  style.textContent = `
#tax-body{display:block;}
.tx-card{background:var(--card);border:0.5px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin:0 0 14px;}
.tx-label{font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;display:block;}
.tx-amount-wrap{display:flex;align-items:baseline;gap:8px;border-bottom:1px solid var(--border);padding-bottom:10px;}
.tx-amount-sym{font-size:22px;font-weight:800;color:var(--text3);}
#tx-amount{flex:1;border:none;outline:none;background:transparent;font-family:inherit;font-size:28px;font-weight:800;
  color:var(--text);padding:2px 0;min-width:0;}
.tx-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.tx-row:last-child{margin-bottom:0;}
.tx-row-title{font-size:14px;font-weight:700;color:var(--text2);}
.tx-chip-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.tx-chip{border:1.5px solid var(--border-mid);background:var(--card);color:var(--text2);font-family:inherit;
  font-size:13px;font-weight:700;padding:8px 13px;border-radius:20px;cursor:pointer;transition:all .12s;}
.tx-chip.active{background:var(--brand);border-color:var(--brand);color:#fff;}
.tx-chip:focus-visible,.tx-custom-input:focus-visible,#tx-amount:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand);}
.tx-custom-wrap{display:flex;align-items:center;gap:4px;border:1.5px solid var(--border-mid);border-radius:20px;padding:6px 6px 6px 12px;}
.tx-custom-input{width:44px;border:none;outline:none;background:transparent;font-family:inherit;font-size:13px;
  font-weight:700;color:var(--text);padding:2px 0;-moz-appearance:textfield;}
.tx-custom-input::-webkit-outer-spin-button,.tx-custom-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.tx-custom-input:focus-visible{border-radius:9px;}
.tx-custom-suffix{font-size:12px;font-weight:700;color:var(--text3);padding-right:4px;}
.tx-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;}
.tx-switch input{position:absolute;inset:0;opacity:0;width:44px;height:24px;margin:0;cursor:pointer;}
.tx-switch-track{width:44px;height:24px;background:var(--border-mid);border-radius:12px;position:relative;transition:background .15s;}
.tx-switch input:checked + .tx-switch-track{background:var(--brand);}
.tx-switch input:focus-visible + .tx-switch-track{box-shadow:0 0 0 2px var(--brand);}
.tx-switch-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;
  transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.25);}
.tx-switch input:checked + .tx-switch-track .tx-switch-thumb{left:22px;}
.tx-vat-pct{display:flex;align-items:center;gap:10px;margin-top:12px;}
.tx-vat-pct.disabled{opacity:.4;pointer-events:none;}
.tx-breakdown-line{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:14px;color:var(--text2);}
.tx-breakdown-line.sub{color:var(--text3);font-size:13px;}
.tx-breakdown-line .v{font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;}
.tx-breakdown-line .v.neg{color:var(--overdue);}
.tx-breakdown-line .v.pos{color:var(--paid);}
.tx-divider{height:1px;background:var(--border);margin:2px 0;}
.tx-final{display:flex;justify-content:space-between;align-items:baseline;padding-top:10px;}
.tx-final .lbl{font-size:14px;font-weight:800;color:var(--text);}
.tx-final .amt{font-size:26px;font-weight:800;color:var(--brand);letter-spacing:-.5px;font-variant-numeric:tabular-nums;}
.tx-note{font-size:12px;line-height:1.5;color:var(--text3);padding:2px 2px 0;}
.tx-btn{width:100%;padding:14px;background:var(--brand-tint);color:var(--brand);border:1.5px solid transparent;
  border-radius:var(--radius-sm);font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;transition:background .12s;}
.tx-btn:active{background:color-mix(in srgb,var(--brand) 20%,var(--brand-tint));}
.tx-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand);}
`;
  document.head.appendChild(style);
}

function taxChipActive(v) {
  return Math.abs(Number(taxState.whtPct) - v) < 1e-9;
}

function taxSelectWht(v) {
  taxState.whtPct = v;
  document.querySelectorAll('#tx-wht-chips .tx-chip').forEach(btn => {
    const on = Math.abs(Number(btn.dataset.val) - v) < 1e-9;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const custom = document.getElementById('tx-wht-custom');
  if (custom) custom.value = v;
  taxUpdateBreakdown();
}
window.taxSelectWht = taxSelectWht;

function taxOnWhtCustom(v) {
  const n = parseFloat(v);
  taxState.whtPct = isFinite(n) && n >= 0 ? n : 0;
  document.querySelectorAll('#tx-wht-chips .tx-chip').forEach(btn => {
    const on = Math.abs(Number(btn.dataset.val) - taxState.whtPct) < 1e-9;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  taxUpdateBreakdown();
}
window.taxOnWhtCustom = taxOnWhtCustom;

function taxToggleVat(checked) {
  taxState.vatOn = !!checked;
  const wrap = document.getElementById('tx-vat-pct-wrap');
  const input = document.getElementById('tx-vat-pct');
  if (wrap) wrap.classList.toggle('disabled', !checked);
  if (input) input.disabled = !checked;
  taxUpdateBreakdown();
}
window.taxToggleVat = taxToggleVat;

function taxOnVatPct(v) {
  const n = parseFloat(v);
  taxState.vatPct = isFinite(n) && n >= 0 ? n : 0;
  taxUpdateBreakdown();
}
window.taxOnVatPct = taxOnVatPct;

function taxOnAmountInput(v) {
  const n = parseFloat(v);
  taxState.amount = isFinite(n) && n >= 0 ? n : 0;
  taxUpdateBreakdown();
}
window.taxOnAmountInput = taxOnAmountInput;

// Trims trailing .0 for a clean "3%" instead of "3.0%" while still showing
// decimals a user actually typed (e.g. "2.5%").
function taxOptNum(n) {
  const num = Number(n) || 0;
  return (Math.round(num * 100) / 100).toString();
}

function taxUpdateBreakdown() {
  const subtotal = Number(taxState.amount) || 0;
  const whtPct = Number(taxState.whtPct) || 0;
  const vatPct = taxState.vatOn ? (Number(taxState.vatPct) || 0) : 0;
  const r = computeTax(subtotal, whtPct, vatPct);

  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  set('tx-out-fee', money(subtotal, 2));
  set('tx-out-vat-lbl', `+ VAT (${taxOptNum(vatPct)}%)`);
  set('tx-out-vat', '+ ' + money(r.vat, 2));
  set('tx-out-clientpays', money(r.clientPays, 2));
  set('tx-out-wht-lbl', `− WHT (${taxOptNum(whtPct)}%)`);
  set('tx-out-wht', '− ' + money(r.wht, 2));
  set('tx-out-receive', money(r.youReceive, 2));
}

function taxUseInInvoice() {
  const subtotal = Number(taxState.amount) || 0;
  if (!(subtotal > 0)) { toast('Enter an amount first'); return; }
  switchScreen('invoices');
  if (typeof openInvoiceForm === 'function') openInvoiceForm();
  const vatPct = taxState.vatOn ? (Number(taxState.vatPct) || 0) : 0;
  toast(`Add a line item of ${money(subtotal, 2)} — WHT ${taxOptNum(taxState.whtPct)}%, VAT ${taxOptNum(vatPct)}%`);
}
window.taxUseInInvoice = taxUseInInvoice;

// ─── screen renderer ────────────────────────────────────────────────────
function renderTax() {
  const el = document.getElementById('tax-body');
  if (!el) return;

  if (!taxState) taxState = taxDefaultState();
  taxEnsureStyles();

  const chipsHtml = WHT_PRESETS.map(v =>
    `<button type="button" class="tx-chip${taxChipActive(v) ? ' active' : ''}" data-val="${v}" aria-pressed="${taxChipActive(v) ? 'true' : 'false'}" onclick="taxSelectWht(${v})">${v}%</button>`
  ).join('');

  el.innerHTML = `
    <div class="tx-card">
      <span class="tx-label">Fee amount (before tax)</span>
      <div class="tx-amount-wrap">
        <span class="tx-amount-sym">${curSym()}</span>
        <input id="tx-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00"
          aria-label="Fee amount before tax" value="${taxState.amount === '' ? '' : taxState.amount}"
          oninput="taxOnAmountInput(this.value)">
      </div>
    </div>

    <div class="tx-card">
      <span class="tx-label">Withholding tax (WHT)</span>
      <div class="tx-chip-row" id="tx-wht-chips" role="group" aria-label="WHT percent presets">
        ${chipsHtml}
        <div class="tx-custom-wrap">
          <input id="tx-wht-custom" class="tx-custom-input" type="number" min="0" max="100" step="0.1"
            aria-label="Custom WHT percent" value="${taxState.whtPct}" oninput="taxOnWhtCustom(this.value)">
          <span class="tx-custom-suffix">%</span>
        </div>
      </div>
    </div>

    <div class="tx-card">
      <div class="tx-row">
        <span class="tx-row-title">Charge VAT</span>
        <label class="tx-switch">
          <input type="checkbox" id="tx-vat-on" ${taxState.vatOn ? 'checked' : ''} aria-label="Charge VAT" onchange="taxToggleVat(this.checked)">
          <span class="tx-switch-track"><span class="tx-switch-thumb"></span></span>
        </label>
      </div>
      <div class="tx-vat-pct${taxState.vatOn ? '' : ' disabled'}" id="tx-vat-pct-wrap">
        <span class="tx-custom-suffix" style="padding-right:0;">VAT rate</span>
        <div class="tx-custom-wrap">
          <input id="tx-vat-pct" class="tx-custom-input" type="number" min="0" max="100" step="0.1"
            aria-label="VAT percent" value="${taxState.vatPct}" ${taxState.vatOn ? '' : 'disabled'} oninput="taxOnVatPct(this.value)">
          <span class="tx-custom-suffix">%</span>
        </div>
      </div>
    </div>

    <div class="tx-card">
      <span class="tx-label">Breakdown</span>
      <div class="tx-breakdown-line"><span>Fee</span><span class="v" id="tx-out-fee">${money(0, 2)}</span></div>
      <div class="tx-breakdown-line sub"><span id="tx-out-vat-lbl">+ VAT (${taxOptNum(taxState.vatOn ? taxState.vatPct : 0)}%)</span><span class="v pos" id="tx-out-vat">+ ${money(0, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-breakdown-line"><span>Client pays</span><span class="v" id="tx-out-clientpays">${money(0, 2)}</span></div>
      <div class="tx-breakdown-line sub"><span id="tx-out-wht-lbl">− WHT (${taxOptNum(taxState.whtPct)}%)</span><span class="v neg" id="tx-out-wht">− ${money(0, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-final"><span class="lbl">You receive</span><span class="amt" id="tx-out-receive">${money(0, 2)}</span></div>
    </div>

    <button type="button" class="tx-btn" onclick="taxUseInInvoice()">Use in new invoice →</button>

    <p class="tx-note">Estimate only, not tax advice. WHT and VAT rates vary by service type and client status — confirm with an accountant or the Revenue Department before filing.</p>
  `;

  taxUpdateBreakdown();
}
window.renderTax = renderTax;
