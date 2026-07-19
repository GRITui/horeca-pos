/* Sidekick — portfolio.js  (M3 PORTFOLIO)
 *
 * OWNED BY the portfolio agent. Fills #portfolio-body only. Loaded AFTER
 * app.js (and tax.js / invoices.js / docgen.js / followups.js), so all app.js
 * globals (dbAll, dbAdd, dbPut, dbDel, dbGet, cuid, nowISO, todayISO, money,
 * fmt, curSym, htmlEsc, attrEsc, toast, switchScreen, currentUser, isGuest)
 * are available at call time. English-only, light-mode-first — CSS vars follow
 * the app's theme tokens automatically, no dark-mode work needed here.
 *
 * Public surface (kept on window):
 *   - renderPortfolio()    — fills #portfolio-body
 *   - openPortfolioForm()  — opens the add/edit modal
 *
 * All modals + the print root are created at runtime, appended to
 * document.body, and namespaced with a `pf-` prefix so they cannot collide
 * with other modules' DOM. No shared file is touched.
 */
'use strict';

(function () {

  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'portfolio';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }

  // Data-URL held in module state (never in a hidden DOM input — can be MBs).
  let editing = null;
  let pickedImage = null;

  async function loadItems() {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid);
    rows.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    return rows;
  }

  function tagChips(tags) {
    const parts = String(tags || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return '';
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">` +
      parts.map(t => `<span class="chip" style="background:var(--brand-tint);color:var(--brand)">${esc(t)}</span>`).join('') +
      `</div>`;
  }

  function snippet(desc) {
    const s = String(desc || '').trim();
    if (!s) return '';
    return s.length > 120 ? s.slice(0, 117).trimEnd() + '…' : s;
  }

  // ── LIST SCREEN → #portfolio-body ─────────────────────────────────────
  async function renderPortfolio() {
    const el = document.getElementById('portfolio-body');
    if (!el) return;

    let rows;
    try {
      rows = await loadItems();
    } catch (err) {
      console.error('renderPortfolio', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load portfolio.</p></div>`;
      return;
    }

    const addBtn = `<button type="button" id="pf-add-btn" class="btn-submit" style="width:100%;margin:0 0 16px">+ Add item</button>`;

    if (!rows.length) {
      el.innerHTML = addBtn +
        `<div class="empty"><div class="empty-icon">🖼️</div>
           <p>No portfolio items yet</p>
           <span>Add your best work to show prospective clients.</span>
         </div>`;
      document.getElementById('pf-add-btn').addEventListener('click', () => openPortfolioForm());
      return;
    }

    const shareBtn = `<button type="button" id="pf-share-btn" style="width:100%;margin:0 0 16px;padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">Share / Print</button>`;

    const cards = rows.map(r => {
      const thumb = r.imageDataUrl
        ? `<img src="${aesc(r.imageDataUrl)}" alt="" style="width:64px;height:64px;border-radius:var(--radius-sm);object-fit:cover;flex-shrink:0;background:var(--brand-tint)">`
        : `<div class="list-icon" style="width:64px;height:64px;border-radius:var(--radius-sm);font-size:26px">🖼️</div>`;
      const snip = snippet(r.description);
      return `<div class="list-row" data-pf="${r.id}" tabindex="0" role="button" style="align-items:flex-start">
        ${thumb}
        <div class="list-main">
          <div class="list-title">${esc(r.title || 'Untitled')}</div>
          ${snip ? `<div class="list-sub">${esc(snip)}</div>` : ''}
          ${tagChips(r.tags)}
        </div>
        <div class="list-right"><span style="color:var(--text3);font-size:18px">›</span></div>
      </div>`;
    }).join('');

    el.innerHTML = addBtn + shareBtn + '<div class="list-card">' + cards + '</div>';

    document.getElementById('pf-add-btn').addEventListener('click', () => openPortfolioForm());
    document.getElementById('pf-share-btn').addEventListener('click', () => printPortfolio(rows));
    el.querySelectorAll('[data-pf]').forEach(row => {
      const open = () => openEditFromId(parseInt(row.getAttribute('data-pf'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }
  window.renderPortfolio = renderPortfolio;

  async function openEditFromId(id) {
    const item = await dbGet(STORE, id);
    if (!item || item.uid !== uidNow()) { toast('Item not found'); return; }
    editing = item;
    pickedImage = item.imageDataUrl || null;
    buildFormModal({
      title: item.title || '',
      description: item.description || '',
      tags: item.tags || '',
    }, true);
  }

  // ── ADD / EDIT FORM ───────────────────────────────────────────────────
  function openPortfolioForm() {
    editing = null;
    pickedImage = null;
    buildFormModal({ title: '', description: '', tags: '' }, false);
  }
  window.openPortfolioForm = openPortfolioForm;

  function buildFormModal(v, isEdit) {
    closeModal('pf-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'pf-form-modal';

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Portfolio item form">
        <div class="modal-handle"></div>
        <div class="modal-title">${isEdit ? 'Edit portfolio item' : 'New portfolio item'}</div>
        <div class="form-body">
          <div class="field">
            <label for="pf-title">Title</label>
            <input type="text" id="pf-title" value="${aesc(v.title)}" placeholder="Project or piece name">
          </div>
          <div class="field">
            <label for="pf-desc">Description</label>
            <textarea id="pf-desc" rows="3" placeholder="A short description of the work">${esc(v.description)}</textarea>
          </div>
          <div class="field">
            <label for="pf-tags">Tags (comma-separated)</label>
            <input type="text" id="pf-tags" value="${aesc(v.tags)}" placeholder="e.g. branding, logo, web">
          </div>
          <div class="field">
            <label for="pf-image">Image</label>
            <input type="file" id="pf-image" accept="image/*" style="padding:8px 0;font-size:13px">
          </div>
          <div id="pf-preview-wrap" style="padding:0 16px 12px"></div>
        </div>
        <button type="button" class="btn-submit" id="pf-save">${isEdit ? 'Save changes' : 'Add item'}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="pf-del">Delete item</button>` : ''}
        <button type="button" class="btn-danger" id="pf-cancel" style="border-color:var(--border-mid);color:var(--text3)">Cancel</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    overlay.querySelector('#pf-image').addEventListener('change', onImagePick);
    overlay.querySelector('#pf-save').addEventListener('click', () => saveItem(isEdit));
    overlay.querySelector('#pf-cancel').addEventListener('click', () => closeModal('pf-form-modal'));
    if (isEdit) overlay.querySelector('#pf-del').addEventListener('click', () => deleteItem(editing.id));

    renderPreview();
  }

  function renderPreview() {
    const wrap = document.getElementById('pf-preview-wrap');
    if (!wrap) return;
    if (!pickedImage) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
        <img src="${aesc(pickedImage)}" alt="Preview" style="width:88px;height:88px;border-radius:var(--radius-sm);object-fit:cover;border:0.5px solid var(--border)">
        <button type="button" id="pf-img-remove" style="border:none;background:none;color:var(--overdue);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer;padding:6px 4px">× Remove image</button>
      </div>`;
    const rm = wrap.querySelector('#pf-img-remove');
    if (rm) rm.addEventListener('click', () => {
      pickedImage = null;
      const input = document.getElementById('pf-image');
      if (input) input.value = '';
      renderPreview();
    });
  }

  function onImagePick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('Image too large — please pick one under 2MB');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { pickedImage = reader.result; renderPreview(); };
    reader.onerror = () => { toast('Could not read that image'); };
    reader.readAsDataURL(file);
  }

  async function saveItem(isEdit) {
    document.querySelectorAll('#pf-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#pf-form-modal .field-err').forEach(el => el.remove());

    const title = document.getElementById('pf-title').value.trim();
    if (!title) { markErr('pf-title', 'Enter a title for this item'); return; }

    const description = document.getElementById('pf-desc').value.trim();
    const tags = document.getElementById('pf-tags').value.trim();

    const base = {
      uid: uidNow(),
      title,
      description,
      tags,
      imageDataUrl: pickedImage || '',
      updatedAt: nowISO(),
    };

    try {
      const mirrorEnabled = !isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled();
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        base.order = (editing.order != null) ? editing.order : 1;
        base.createdAt = editing.createdAt || nowISO();
        await dbPut(STORE, base);
        if (mirrorEnabled) SidekickBackend.mirrorPortfolioSave(base).catch(() => {});
        toast('Item updated');
      } else {
        const rows = await loadItems();
        const maxOrder = rows.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
        base.order = rows.length ? maxOrder + 1 : 1;
        base.cuid = cuid();
        base.createdAt = nowISO();
        await dbAdd(STORE, base);
        if (mirrorEnabled) SidekickBackend.mirrorPortfolioSave(base).catch(() => {});
        toast('Item added');
      }
    } catch (err) {
      console.error('saveItem', err);
      toast('Could not save item');
      return;
    }
    closeModal('pf-form-modal');
    renderPortfolio();
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

  async function deleteItem(id) {
    if (!confirm('Delete this item? This cannot be undone.')) return;
    try {
      const prev = await dbGet(STORE, id);
      await dbDel(STORE, id);
      if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
        SidekickBackend.mirrorPortfolioDelete(prev.cuid).catch(() => {});
      }
    } catch (e) {
      console.error(e);
      toast(t('delete_failed'));
      return;
    }
    closeModal('pf-form-modal');
    toast('Item deleted');
    renderPortfolio();
  }

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

  // ── SHARE / PRINT (print-only DOM + window.print(); scoped print CSS) ──
  function printPortfolio(rows) {
    const prevRoot = document.getElementById('portfolio-print-root');
    if (prevRoot) prevRoot.remove();
    const prevStyle = document.getElementById('pf-print-style');
    if (prevStyle) prevStyle.remove();

    const owner = (typeof currentUser !== 'undefined' && currentUser)
      ? (currentUser.firstName || currentUser.username || 'Sidekick')
      : 'Sidekick';

    const style = document.createElement('style');
    style.id = 'pf-print-style';
    style.textContent = `
      #portfolio-print-root{ display:none; }
      @media print{
        body.pf-printing > *:not(#portfolio-print-root){ display:none !important; }
        body.pf-printing #portfolio-print-root{ display:block !important; position:static; margin:0; padding:28px; background:#fff; }
        body.pf-printing #portfolio-print-root, body.pf-printing #portfolio-print-root *{ color:#111 !important; }
        @page{ margin:14mm; }
        #portfolio-print-root .pf-item{ page-break-inside:avoid; }
      }
      #portfolio-print-root{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
      #portfolio-print-root .pf-wrap{ max-width:760px; margin:0 auto; }
      #portfolio-print-root h1{ font-size:26px; margin:0 0 2px; }
      #portfolio-print-root .pf-head{ border-bottom:2px solid #111; padding-bottom:12px; margin-bottom:20px; }
      #portfolio-print-root .pf-muted{ color:#555; font-size:13px; }
      #portfolio-print-root .pf-item{ display:flex; gap:16px; align-items:flex-start; margin-bottom:22px; }
      #portfolio-print-root .pf-item img{ width:150px; height:150px; object-fit:cover; border:1px solid #ddd; border-radius:8px; flex-shrink:0; }
      #portfolio-print-root .pf-item h2{ font-size:17px; margin:0 0 4px; }
      #portfolio-print-root .pf-item p{ font-size:13px; line-height:1.6; margin:0 0 6px; color:#333; }
      #portfolio-print-root .pf-tag{ display:inline-block; padding:2px 9px; border:1px solid #bbb; border-radius:9px; font-size:11px; margin:0 4px 4px 0; }
    `;
    document.head.appendChild(style);

    const items = rows.map(r => {
      const img = r.imageDataUrl ? `<img src="${aesc(r.imageDataUrl)}" alt="">` : '';
      const tags = String(r.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        .map(t => `<span class="pf-tag">${esc(t)}</span>`).join('');
      const desc = String(r.description || '').trim();
      return `<div class="pf-item">
        ${img}
        <div>
          <h2>${esc(r.title || 'Untitled')}</h2>
          ${desc ? `<p>${esc(desc)}</p>` : ''}
          ${tags ? `<div>${tags}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const root = document.createElement('div');
    root.id = 'portfolio-print-root';
    root.innerHTML = `
      <div class="pf-wrap">
        <div class="pf-head">
          <h1>Portfolio</h1>
          <div class="pf-muted">${esc(owner)}</div>
        </div>
        ${items}
      </div>`;
    document.body.appendChild(root);

    const cleanup = () => {
      document.body.classList.remove('pf-printing');
      root.remove();
      style.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    document.body.classList.add('pf-printing');
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => { window.print(); }, 60);
    setTimeout(cleanup, 60000);
  }

})();
