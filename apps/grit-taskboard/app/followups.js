/* Sidekick — followups.js  (M3 FOLLOW-UP QUEUE / lightweight CRM)
 *
 * OWNED BY the CRM agent. Loaded AFTER app.js and invoices.js, so app.js
 * globals (dbAll, dbAdd, dbPut, cuid, nowISO, todayISO, htmlEsc, attrEsc,
 * toast, customers, jobs, currentUser, isGuest) are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderFollowups()   — fills #followups-body
 *
 * The queue itself is NEVER stored: it is recomputed live on every render from
 * customers / jobs / the READ-ONLY 'invoices' store. The 'followups' store
 * holds ONLY the user's snooze/dismiss decisions, matched back by a stable key.
 * English-only, light-mode.
 */
'use strict';

(function () {

  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'followups';
  const DRAFT_STALE_DAYS = 3;
  const CUSTOMER_STALE_DAYS = 30;

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }

  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function daysBetween(fromISO, toISO) {
    const a = new Date(fromISO + 'T12:00:00'), b = new Date(toISO + 'T12:00:00');
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.round((b - a) / 86400000);
  }

  let queue = [];           // active candidates (not dismissed, not currently snoozed)
  let dismissedQueue = [];  // dismissed candidates, kept around so Undo can restore them
  let showDismissed = false;

  async function buildQueue() {
    const uid = uidNow();
    const today = todayISO();
    const invoices = (await dbAll('invoices')).filter(r => r.uid === uid);
    const custList = (typeof customers !== 'undefined' ? customers : []);
    const jobList = (typeof jobs !== 'undefined' ? jobs : []);
    const custById = new Map(custList.map(c => [String(c.id), c]));

    const candidates = [];

    // 1. Overdue invoices, 2. Unsent drafts.
    invoices.forEach(inv => {
      const cid = inv.clientId != null && inv.clientId !== '' ? String(inv.clientId) : '';
      const cust = cid ? custById.get(cid) : null;
      const name = (cust && cust.name) || inv.clientName || 'No client';

      // Either the user marked the invoice 'overdue' directly, or it's still
      // unpaid past its due date — a blank/cleared dueDate shouldn't hide an
      // invoice the user has explicitly flagged as overdue.
      if (inv.status === 'overdue' || (inv.status !== 'paid' && inv.dueDate && inv.dueDate < today)) {
        const n = inv.dueDate && inv.dueDate < today ? daysBetween(inv.dueDate, today) : 0;
        candidates.push({
          group: 0, sortN: n, icon: '🧾', title: name,
          reason: n > 0
            ? `Invoice ${inv.number || ''} is ${n} day${n === 1 ? '' : 's'} overdue`
            : `Invoice ${inv.number || ''} is marked overdue`,
          key: `overdue:${cid}:${inv.id}`,
          msgData: { name, number: inv.number || '', n },
        });
      } else if (inv.status === 'draft' && inv.issueDate && daysBetween(inv.issueDate, today) >= DRAFT_STALE_DAYS) {
        const n = daysBetween(inv.issueDate, today);
        candidates.push({
          group: 1, sortN: n, icon: '🧾', title: name,
          reason: `Draft invoice ${inv.number || ''} has been sitting unsent for ${n} day${n === 1 ? '' : 's'}`,
          key: `draft:${cid}:${inv.id}`,
          msgData: { name, number: inv.number || '', n },
        });
      }
    });

    // 3. Stale customers — only those with prior job/invoice history.
    custList.forEach(c => {
      const dates = [];
      jobList.forEach(j => { if (j.clientId === c.id && j.date) dates.push(j.date); });
      invoices.forEach(inv => {
        if (inv.clientId != null && String(inv.clientId) === String(c.id) && inv.issueDate) dates.push(inv.issueDate);
      });
      if (!dates.length) return;   // nothing to be stale about yet
      const last = dates.reduce((mx, d) => (d > mx ? d : mx), dates[0]);
      const n = daysBetween(last, today);
      if (n > CUSTOMER_STALE_DAYS) {
        candidates.push({
          group: 2, sortN: n, icon: '👤', title: c.name || 'Customer',
          reason: `No activity with ${c.name || 'this customer'} in ${n} days`,
          key: `stale:${c.id}:`,
          msgData: { name: c.name || 'there', n },
        });
      }
    });

    // 4. Session packages that have run out — a natural moment to ask about
    // renewal, using the same key-based snooze/dismiss mechanism as the other
    // candidate types (not a stored follow-up record of its own).
    if (typeof clientPackages === 'function' && typeof packageRemaining === 'function') {
      custList.forEach(c => {
        const own = clientPackages(c.id);
        if (!own.length) return;
        const latest = own[0];   // clientPackages() sorts most-recent-purchase-first
        if (packageRemaining(latest) > 0) return;   // still has sessions left, nothing to ask about
        candidates.push({
          group: 3, sortN: 0, icon: '📦', title: c.name || 'Customer',
          reason: `${c.name || 'This client'}'s ${latest.totalSessions}-session package is used up — ask about renewing`,
          key: `pkg-empty:${c.id}:${latest.id}`,
          msgData: { name: c.name || 'there', n: latest.totalSessions },
        });
      });
    }

    // Apply snooze/dismiss decisions. Dismissed candidates are split out
    // (rather than dropped) so the "Show dismissed" panel can list them with
    // an Undo action — the underlying invoice/customer is never touched by
    // any of this, only which reminders are currently visible.
    const decisions = new Map();
    (await dbAll(STORE)).filter(r => r.uid === uid).forEach(r => decisions.set(r.key, r));
    const active = [], dismissed = [];
    candidates.forEach(cand => {
      const rec = decisions.get(cand.key);
      if (rec && rec.dismissed === true) { dismissed.push(cand); return; }
      if (rec && rec.snoozedUntil && rec.snoozedUntil >= today) return;
      active.push(cand);
    });

    const bySort = (a, b) => (a.group - b.group) || (b.sortN - a.sortN);
    active.sort(bySort);
    dismissed.sort(bySort);
    return { active, dismissed };
  }

  async function applyDecision(key, patch) {
    const uid = uidNow();
    const existing = (await dbAll(STORE)).filter(r => r.uid === uid).find(r => r.key === key);
    // Existing followup rows predate the cuid convention (this store was
    // never part of the initial backend-migration slice) — mint one lazily
    // on first mirror rather than requiring a separate backfill migration,
    // same as every other cuid-bearing store already does on first save.
    let record;
    if (existing) {
      Object.assign(existing, patch, { updatedAt: nowISO() });
      if (!existing.cuid) existing.cuid = cuid();
      await dbPut(STORE, existing);
      record = existing;
    } else {
      record = {
        uid, key, dismissed: false, snoozedUntil: '',
        createdAt: nowISO(), updatedAt: nowISO(),
        cuid: cuid(),
        ...patch,
      };
      await dbAdd(STORE, record);
    }
    if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
      SidekickBackend.mirrorFollowupSave(record).catch(() => {});
    }
  }

  async function snooze(key) {
    try { await applyDecision(key, { snoozedUntil: addDays(todayISO(), 7), dismissed: false }); }
    catch (e) { console.error(e); toast('Could not snooze'); return; }
    toast('Snoozed for 7 days');
    renderFollowups();
  }
  async function dismiss(key) {
    try { await applyDecision(key, { dismissed: true }); }
    catch (e) { console.error(e); toast('Could not dismiss'); return; }
    toast('Dismissed');
    renderFollowups();
  }
  async function undismiss(key) {
    try { await applyDecision(key, { dismissed: false, snoozedUntil: '' }); }
    catch (e) { console.error(e); toast('Could not restore'); return; }
    toast('Restored to follow-ups');
    renderFollowups();
  }

  // Copy message template to clipboard, substituting placeholders from msgData.
  async function copyMessage(msgData, groupType) {
    const templates = {
      0: t('followup_tpl_overdue'),    // overdue invoice
      1: t('followup_tpl_draft'),      // draft invoice
      2: t('followup_tpl_stale'),      // stale customer
      3: t('followup_tpl_package'),    // package renewal
    };
    const template = templates[groupType] || templates[0];
    let msg = template;
    if (msgData) {
      msg = msg.replace('{name}', msgData.name || '');
      msg = msg.replace('{number}', msgData.number || '');
      msg = msg.replace('{n}', msgData.n || '');
    }

    // Try modern clipboard API first, fall back to textarea method
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(msg);
        toast(t('followup_copied_toast'));
      } catch (e) {
        console.error(e);
        fallbackCopy(msg);
      }
    } else {
      fallbackCopy(msg);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      document.execCommand('copy');
      toast(t('followup_copied_toast'));
    } catch (e) {
      console.error(e);
      toast('Could not copy — select and copy manually.');
    }
    document.body.removeChild(textarea);
  }

  async function renderFollowups() {
    const el = document.getElementById('followups-body');
    if (!el) return;
    try {
      const built = await buildQueue();
      queue = built.active;
      dismissedQueue = built.dismissed;
    } catch (err) {
      console.error('renderFollowups', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load follow-ups.</p></div>`;
      return;
    }

    const activeHtml = !queue.length
      ? `<div class="empty"><div class="empty-icon">✅</div><p>You're all caught up</p></div>`
      : '<div class="list-card">' + queue.map((it, i) => `
      <div class="list-row" style="cursor:default">
        <div class="list-icon">${it.icon}</div>
        <div class="list-main">
          <div class="list-title">${esc(it.title)}</div>
          <div class="list-sub">${esc(it.reason)}</div>
        </div>
        <div class="list-right" style="display:flex;gap:6px">
          <button type="button" data-fu-copy="${i}" style="padding:7px 9px;border:1px solid var(--border);background:var(--card);color:var(--text3);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">${esc(t('followup_copy_btn'))}</button>
          <button type="button" data-fu-snooze="${i}" style="padding:7px 9px;border:1px solid var(--border);background:var(--card);color:var(--text3);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Snooze 7d</button>
          <button type="button" data-fu-dismiss="${i}" style="padding:7px 9px;border:1px solid var(--overdue);background:none;color:var(--overdue);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Dismiss</button>
        </div>
      </div>`).join('') + '</div>';

    const dismissedHtml = !dismissedQueue.length ? '' : (showDismissed
      ? `<div style="margin-top:16px">
          <button type="button" id="fu-toggle-dismissed" style="background:none;border:none;color:var(--text3);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:8px 2px">Hide dismissed (${dismissedQueue.length})</button>
          <div class="list-card">${dismissedQueue.map((it, i) => `
            <div class="list-row" style="cursor:default;opacity:.7">
              <div class="list-icon">${it.icon}</div>
              <div class="list-main">
                <div class="list-title">${esc(it.title)}</div>
                <div class="list-sub">${esc(it.reason)}</div>
              </div>
              <div class="list-right">
                <button type="button" data-fu-undismiss="${i}" style="padding:7px 9px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Undo</button>
              </div>
            </div>`).join('')}</div>
        </div>`
      : `<div style="margin-top:16px"><button type="button" id="fu-toggle-dismissed" style="background:none;border:none;color:var(--text3);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:8px 2px">Show dismissed (${dismissedQueue.length})</button></div>`);

    el.innerHTML = activeHtml + dismissedHtml;

    const toggleBtn = document.getElementById('fu-toggle-dismissed');
    if (toggleBtn) toggleBtn.addEventListener('click', () => { showDismissed = !showDismissed; renderFollowups(); });

    el.querySelectorAll('[data-fu-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = queue[parseInt(btn.getAttribute('data-fu-copy'), 10)];
        if (it) copyMessage(it.msgData, it.group);
      });
    });
    el.querySelectorAll('[data-fu-snooze]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = queue[parseInt(btn.getAttribute('data-fu-snooze'), 10)];
        if (it) snooze(it.key);
      });
    });
    el.querySelectorAll('[data-fu-dismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = queue[parseInt(btn.getAttribute('data-fu-dismiss'), 10)];
        if (it) dismiss(it.key);
      });
    });
    el.querySelectorAll('[data-fu-undismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = dismissedQueue[parseInt(btn.getAttribute('data-fu-undismiss'), 10)];
        if (it) undismiss(it.key);
      });
    });
  }
  window.renderFollowups = renderFollowups;

})();
