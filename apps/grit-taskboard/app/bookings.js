/* Sidekick — bookings.js  (M3 BOOKING — day view + travel buffers)
 *
 * OWNED BY the booking agent. Replaces the stub entirely.
 * Loaded AFTER app.js (and the other M2/M3 modules), so app.js globals (dbAll,
 * dbAdd, dbPut, dbDel, dbGet, cuid, nowISO, todayISO, money, fmt, curSym,
 * htmlEsc, attrEsc, toast, switchScreen, fmtDate, settings, customers, services,
 * jobs, currentUser, isGuest) are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderBookings()           — fills #book-body (a single-day agenda)
 *   - openBookingForm(dateISO?, startTime?)  — create/edit booking UI
 *
 * Self-contained day-view agenda over the 'bookings' IndexedDB store: prev/today/
 * next date nav, per-day list sorted by start time, and travel-buffer gap strips
 * between adjacent bookings. Fully localized (en/th) via app.js's t()/I18N;
 * light-mode.
 */
'use strict';

(function () {

  // ══════════════════════════════════════════════════════════════════════
  //  Small local helpers
  // ══════════════════════════════════════════════════════════════════════
  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'bookings';
  // Safety cap on how many extra rows a single "repeat until" can generate —
  // protects against an accidental far-future end date silently creating
  // thousands of booking rows (e.g. weekly for 10 years).
  const MAX_REPEAT_OCCURRENCES = 52;
  // Same outline used by the nav's Book icon — kept as a shared line icon
  // instead of the 📅 emoji, matching the SVG icon style used elsewhere
  // (Pipeline's stage icons, the old jump-to-date button).
  const CAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:block"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }
  function n(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
  function pad2(v) { return String(v).padStart(2, '0'); }

  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // Time math is done in minutes-since-midnight throughout: HH:MM strings don't
  // subtract cleanly and gap/end computations need plain integer arithmetic.
  function toMin(hhmm) {
    if (!hhmm) return 0;
    const parts = String(hhmm).split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }
  function fmtMin(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440; // wrap past-midnight ends into a clock time
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  // Full weekday name, localized — indexed by Date#getDay() (0=Sunday..6=Saturday).
  const WD_FULL_KEYS = ['wd_full_sun', 'wd_full_mon', 'wd_full_tue', 'wd_full_wed', 'wd_full_thu', 'wd_full_fri', 'wd_full_sat'];
  function wdFullLabel(dayIdx) { return t(WD_FULL_KEYS[dayIdx]); }

  // Readable header label: reuse app.js's fmtDate, prefix with a relative word.
  function dayLabel(iso) {
    const base = (typeof fmtDate === 'function') ? fmtDate(iso) : iso;
    if (iso === todayISO()) return t('cal_today') + ' · ' + base;
    if (iso === addDays(todayISO(), 1)) return t('cal_tomorrow') + ' · ' + base;
    if (iso === addDays(todayISO(), -1)) return t('cal_yesterday') + ' · ' + base;
    const d = new Date(iso + 'T12:00:00');
    const wd = isNaN(d) ? '' : wdFullLabel(d.getDay()) + ' · ';
    return wd + base;
  }

  function customerName(id) {
    if (id == null || id === '') return '';
    const c = (typeof customers !== 'undefined' ? customers : []).find(x => x.id === id);
    return c ? (c.name || '') : '';
  }

  async function loadBookings(dateISO) {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid && r.date === dateISO);
    rows.sort((a, b) => {
      const d = toMin(a.startTime) - toMin(b.startTime);
      if (d !== 0) return d;
      return (a.id || 0) - (b.id || 0);
    });
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MONTH CALENDAR  →  #book-body
  // ══════════════════════════════════════════════════════════════════════
  // A full month grid replaces the old single-day agenda as the landing view:
  // each cell gets a small legend dot if that date has a booking and/or a
  // pipeline engagement (a 'jobs' record dated that day), so the user can see
  // where the month's activity is without stepping through days one at a
  // time. Tapping a cell expands an inline agenda panel below the grid (the
  // day-list rendering itself — buildDayList/rowHtml/stripHtml — is unchanged
  // from the old day view, just relocated into that panel).
  let selectedDate = todayISO();          // last date the user looked at (fallback for "+ New booking")
  let expandedDate = todayISO();          // date whose agenda panel is open beneath the grid; null = collapsed
  let calMonth = todayISO().slice(0, 7);  // 'YYYY-MM' currently shown in the grid
  // Week/Month segmented toggle (redesign handoff) — persisted like any other
  // Settings value, read straight from the shared global `settings` object
  // (bookings.js loads after app.js, sharing its global scope, same as every
  // other app.js global this file already reads).
  let calMode = (settings && settings.calViewMode === 'week') ? 'week' : 'month';
  let editing = null;                     // full record being edited, or null on create

  function shiftMonth(ym, delta) {
    let [y, m] = ym.split('-').map(Number);
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return `${y}-${pad2(m)}`;
  }
  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  // Small local datasets (bookings + jobs both live entirely on-device), so it's
  // cheapest to just compute the full set of active dates once per render
  // rather than re-querying per visible day, including the leading/trailing
  // days from adjacent months shown to fill the grid. Pipeline dates are
  // bucketed per CURRENT stage (jobStage()), not just "has a job" — the
  // calendar dot for a day shows exactly which stage(s) its engagements are
  // in, using the same stage names/colors as the Pipeline board.
  async function computeActivitySets() {
    const uid = uidNow();
    const allBookings = (await dbAll(STORE)).filter(r => r.uid === uid && r.status !== 'cancelled');
    const bookingDates = new Set(allBookings.map(r => r.date));
    const stageDates = {};        // stage id -> Set of dates (legend scoping)
    const stagesByDate = {};      // iso -> array of stage ids, one entry per engagement that day
    (typeof STAGES !== 'undefined' ? STAGES : []).forEach(s => { stageDates[s] = new Set(); });
    (typeof jobs !== 'undefined' ? jobs : []).forEach(j => {
      if (!j.date || typeof jobStage !== 'function') return;
      const s = jobStage(j);
      if (!stageDates[s]) return;
      stageDates[s].add(j.date);
      (stagesByDate[j.date] = stagesByDate[j.date] || []).push(s);
    });
    return { bookingDates, stageDates, stagesByDate };
  }

  // All dates shown in the ym grid, including the leading/trailing padding
  // days borrowed from adjacent months — used both to render cells and to
  // scope the legend to only what's actually visible this month.
  function monthGridDates(ym) {
    const [y, m] = ym.split('-').map(Number);
    const startWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday=0..Sunday=6
    const numDays = new Date(y, m, 0).getDate();
    const prevMonthDays = new Date(y, m - 1, 0).getDate();
    const out = [];
    for (let i = 0; i < startWeekday; i++) {
      const dayNum = prevMonthDays - startWeekday + 1 + i;
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      out.push({ iso: `${py}-${pad2(pm)}-${pad2(dayNum)}`, dayNum, dim: true });
    }
    for (let d = 1; d <= numDays; d++) {
      out.push({ iso: `${y}-${pad2(m)}-${pad2(d)}`, dayNum: d, dim: false });
    }
    const trailing = (7 - ((startWeekday + numDays) % 7)) % 7;
    for (let i = 1; i <= trailing; i++) {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      out.push({ iso: `${ny}-${pad2(nm)}-${pad2(i)}`, dayNum: i, dim: true });
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  WEEK VIEW — P2 "Calendar Week view" (assessed & recommended; distinct
  //  from the rejected work-week/quarter/year modes, which stay dead).
  //  A real 7-day-column hour grid (like the Pipeline Gantt's day axis, just
  //  per-hour instead of per-day) replaces the previous "week strip selector
  //  + one day's timeline underneath" shape — the whole week is visible at
  //  once instead of one day at a time behind a picker.
  // ══════════════════════════════════════════════════════════════════════
  // The 7 Mon–Sun dates for the week containing `iso` — same Monday-start
  // convention monthGridDates() already uses for the month grid.
  function weekDates(iso) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    const mondayOffset = (d.getDay() + 6) % 7; // Monday=0..Sunday=6
    const out = [];
    for (let i = -mondayOffset; i < 7 - mondayOffset; i++) out.push(addDays(iso, i));
    return out;
  }
  // Nav-bar label for the week, e.g. "14–20 Jul 2026" or, across a month/
  // year boundary, "28 Jun – 4 Jul 2026" / "29 Dec 2025 – 4 Jan 2026". Not
  // run through t() — same as monthLabel()'s existing 'en-GB' formatting,
  // which this mirrors rather than reinventing a second date-format path.
  function weekLabel(dates) {
    const start = new Date(dates[0] + 'T12:00:00');
    const end = new Date(dates[6] + 'T12:00:00');
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
      return `${start.getDate()}–${end.getDate()} ${end.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
    }
    const mon = d => d.toLocaleDateString('en-GB', { month: 'short' });
    const yearSuffix = start.getFullYear() === end.getFullYear() ? ` ${end.getFullYear()}` : ` ${start.getFullYear()} – ${end.getDate()} ${mon(end)} ${end.getFullYear()}`;
    return start.getFullYear() === end.getFullYear()
      ? `${start.getDate()} ${mon(start)} – ${end.getDate()} ${mon(end)}${yearSuffix}`
      : `${start.getDate()} ${mon(start)}${yearSuffix}`;
  }

  // 06:00–22:00 working window, 1px/min (= 60px/hour row) — chosen so the
  // per-column absolute-position math lines up exactly with the 16 real
  // 60px hour-cell elements each column renders (no separate px<->row
  // rounding to keep in sync).
  const WK_HOUR_START = 6 * 60, WK_HOUR_END = 22 * 60, WK_PX_PER_MIN = 1;
  const WK_MIN_BLOCK_PX = 24; // a very short booking still needs room for its time+title text
  const WK_MAX_LANES = 2;     // side-by-side split cap — see assignLanes() below

  // One dbAll(STORE) covers the whole visible week (same "load once, filter
  // client-side" approach computeActivitySets() uses for the month grid).
  // Cancelled bookings are left out entirely (nothing to tap/edit toward on
  // a grid this dense) — same filtering buildHourTimeline used to do.
  async function loadWeekBookings(dates) {
    const uid = uidNow();
    const set = new Set(dates);
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid && set.has(r.date) && r.status !== 'cancelled');
    const byDate = {};
    dates.forEach(iso => { byDate[iso] = []; });
    rows.forEach(r => { byDate[r.date].push(r); });
    dates.forEach(iso => byDate[iso].sort((a, b) => toMin(a.startTime) - toMin(b.startTime)));
    return byDate;
  }

  // Greedy lane assignment for one day's (already start-time-sorted) rows:
  // walk the day in order, drop any lane whose booking has already ended,
  // then take the lowest free lane number. Lanes are grouped into clusters
  // (a new cluster starts whenever no lane is active) so a day with two
  // separate overlapping pairs doesn't force every block in the day down to
  // the wider pair's narrower width. Deliberately NOT a general N-lane
  // packer: a 3rd+ concurrent booking doesn't get its own full lane, it
  // cascades on top of the lane-1 slot with a small offset instead — good
  // enough for one freelancer's own day, much simpler than real packing.
  function assignLanes(rows) {
    const active = []; // {end, lane}
    let cluster = -1;
    const out = [];
    rows.forEach(r => {
      const start = toMin(r.startTime), end = start + n(r.durationMin);
      for (let i = active.length - 1; i >= 0; i--) { if (active[i].end <= start) active.splice(i, 1); }
      if (active.length === 0) cluster++;
      const used = new Set(active.map(a => a.lane));
      let lane = 0;
      while (used.has(lane)) lane++;
      active.push({ end, lane });
      out.push({ r, lane, cluster });
    });
    const clusterMax = {};
    out.forEach(o => { clusterMax[o.cluster] = Math.max(clusterMax[o.cluster] || 0, o.lane + 1); });
    return out.map(o => ({ r: o.r, lane: o.lane, laneCount: clusterMax[o.cluster] }));
  }

  function wkBlockStyle(top, height, lane, laneCount) {
    const lanes = Math.min(laneCount, WK_MAX_LANES);
    const laneWidth = 100 / lanes;
    if (lane < WK_MAX_LANES) {
      return `top:${top}px;height:${height}px;left:${lane * laneWidth}%;width:calc(${laneWidth}% - 3px);z-index:1`;
    }
    // Cascaded 3rd+ overlap: same width as the last real lane, nudged right
    // in flat px steps and stacked above it (see assignLanes comment above).
    const extra = lane - WK_MAX_LANES + 1;
    return `top:${top}px;height:${height}px;left:calc(${(lanes - 1) * laneWidth}% + ${extra * 6}px);width:calc(${laneWidth}% - 3px);z-index:${1 + extra}`;
  }

  // A booking that starts before 06:00 or ends after 22:00 clamps into the
  // visible range with a ▲/▼ hint rather than disappearing — a 05:30 run
  // must still show up somewhere, not silently vanish off the top of the grid.
  function wkBlockHtml(r, lane, laneCount) {
    const start = toMin(r.startTime), dur = n(r.durationMin), end = start + dur;
    const clampedStart = Math.max(start, WK_HOUR_START);
    const clampedEnd = Math.min(end, WK_HOUR_END);
    const top = Math.round((clampedStart - WK_HOUR_START) * WK_PX_PER_MIN);
    const bottom = Math.round((clampedEnd - WK_HOUR_START) * WK_PX_PER_MIN);
    const height = Math.max(bottom - top, WK_MIN_BLOCK_PX);
    const style = wkBlockStyle(top, height, lane, laneCount);
    const doneCls = r.status === 'done' ? ' wk-block-done' : '';
    const hintUp = start < WK_HOUR_START ? '<span class="wk-hint wk-hint-up" aria-hidden="true">▲</span>' : '';
    const hintDown = end > WK_HOUR_END ? '<span class="wk-hint wk-hint-down" aria-hidden="true">▼</span>' : '';
    // Kept as .cal-tl-block too — the pre-existing pipeline-scheduling suite
    // (tests/check-scheduling.js, out of this pass's touchable-files list)
    // already asserts against that class + [data-bk] for "tap a booking on
    // the week timeline opens its edit form"; this is the same tap target,
    // just re-laid-out into a day column instead of a single-day strip.
    return `<div class="wk-block cal-tl-block${doneCls}" data-bk="${r.id}" tabindex="0" role="button" style="${style}">
        ${hintUp}<div class="wk-block-time tnum">${esc(fmtMin(start))}</div>
        <div class="wk-block-title">${esc(r.title || t('booking_word'))}</div>${hintDown}
      </div>`;
  }

  function wkHourGutterHtml() {
    let out = '';
    for (let h = 6; h < 22; h++) out += `<div class="wk-hour-lbl tnum">${pad2(h)}:00</div>`;
    return out;
  }
  // One tappable cell per hour — an empty tap opens the new-booking form
  // pre-filled with this column's date + this row's hour. Rendered before
  // the booking blocks in DOM order; a block is position:absolute so it
  // always paints (and hit-tests) above the plain-flow cell beneath it,
  // regardless of that DOM order.
  function wkHourCellsHtml(dateISO) {
    let out = '';
    for (let h = 6; h < 22; h++) {
      const hh = pad2(h) + ':00';
      out += `<button type="button" class="wk-hourcell" data-wk-cell-date="${aesc(dateISO)}" data-wk-cell-time="${hh}" aria-label="${aesc(t('cal_add_at_time_aria').replace('{time}', hh))}"></button>`;
    }
    return out;
  }

  function wkHeadRowHtml(dates) {
    const todayIso = todayISO();
    const WD = [t('wd_mon'), t('wd_tue'), t('wd_wed'), t('wd_thu'), t('wd_fri'), t('wd_sat'), t('wd_sun')];
    return `<div class="wk-headrow">
        <div class="wk-corner"></div>
        ${dates.map((iso, i) => {
          const d = new Date(iso + 'T12:00:00');
          const isToday = iso === todayIso;
          const isWeekend = i >= 5; // Monday-start index: 5=Sat, 6=Sun
          return `<div class="wk-day-head${isToday ? ' wk-today' : ''}${isWeekend ? ' wk-weekend' : ''}">
              <span class="wk-day-name">${esc(WD[i])}</span>
              <span class="wk-day-num">${d.getDate()}</span>
            </div>`;
        }).join('')}
      </div>`;
  }

  function wkBodyRowHtml(dates, byDate) {
    const todayIso = todayISO();
    return `<div class="wk-bodyrow">
        <div class="wk-hourgutter">${wkHourGutterHtml()}</div>
        ${dates.map((iso, i) => {
          const isWeekend = i >= 5;
          const laned = assignLanes(byDate[iso] || []);
          const blocks = laned.map(({ r, lane, laneCount }) => wkBlockHtml(r, lane, laneCount)).join('');
          return `<div class="wk-daycol${iso === todayIso ? ' wk-today-col' : ''}${isWeekend ? ' wk-weekend' : ''}" data-wk-day="${aesc(iso)}">
              ${wkHourCellsHtml(iso)}
              ${blocks}
            </div>`;
        }).join('')}
      </div>`;
  }

  // Up to 3 engagements that day render as individual stage-colored dots
  // (matches the legend). More than 3 render as one number badge instead —
  // stacking that many dots doesn't scale for "how many," and the exact
  // breakdown is one tap away in the day panel anyway. The badge is
  // stage-colored when every engagement that day shares one stage,
  // otherwise a neutral brand color (a single dot can't represent a mix).
  const CAL_DOT_MAX = 3;
  function pipelineMarkerHtml(stagesHere) {
    if (!stagesHere || !stagesHere.length) return '';
    if (stagesHere.length <= CAL_DOT_MAX) {
      return stagesHere.map(s => `<span class="cal-dot" style="background:${STAGE_META[s].dot}"></span>`).join('');
    }
    const uniq = Array.from(new Set(stagesHere));
    const color = uniq.length === 1 ? STAGE_META[uniq[0]].dot : 'var(--brand)';
    return `<span class="cal-count" style="background:${color}">${stagesHere.length}</span>`;
  }

  function dayCellHtml(iso, dayNum, dim, bookingDates, stagesByDate) {
    const isToday = iso === todayISO();
    const isSelected = iso === expandedDate;
    const dots = pipelineMarkerHtml(stagesByDate[iso]) + (bookingDates.has(iso) ? '<span class="cal-dot cal-dot-book"></span>' : '');
    const cls = 'cal-cell' + (dim ? ' cal-dim' : '') + (isToday ? ' cal-today' : '') + (isSelected ? ' cal-selected' : '');
    return `<button type="button" class="${cls}" data-cal="${iso}">
        <span class="cal-daynum">${dayNum}</span>
        <span class="cal-dots">${dots}</span>
      </button>`;
  }

  function buildMonthGrid(gridDates, bookingDates, stagesByDate) {
    return gridDates.map(c => dayCellHtml(c.iso, c.dayNum, c.dim, bookingDates, stagesByDate)).join('');
  }

  function emptyDayHtml(dateISO) {
    return `<div class="empty" style="padding:28px 16px">
        <div class="empty-icon" style="font-size:44px;color:var(--brand)">${CAL_SVG}</div>
        <p>${esc(t('cal_nothing_on').replace('{date}', fmtDate(dateISO)))}</p>
        <span>${esc(t('cal_tap_new_session_hint'))}</span>
        ${scheduleBookingLinkHtml(dateISO)}
      </div>`;
  }

  // The main "+ New session" button logs pipeline work, not a scheduled time
  // slot — this small secondary link keeps the duration/travel-buffer
  // booking form (still fully built below) reachable for the "block out a
  // slot on the calendar" use case, without it competing with session-
  // logging for the primary call-to-action.
  function scheduleBookingLinkHtml(dateISO) {
    return `<button type="button" class="cal-schedule-link" onclick="openBookingForm('${aesc(dateISO)}')">${esc(t('cal_schedule_booking_link'))}</button>`;
  }

  // A day's pipeline dot only says "something's here" — this row is what makes
  // it identifiable (which client, which stage), same info the Pipeline board
  // itself shows on a card. Tapping a row jumps straight to that stage there.
  function pipelineDayRowHtml(j) {
    const stage = (typeof jobStage === 'function') ? jobStage(j) : null;
    const meta = (stage && STAGE_META[stage]) || {};
    const amt = (typeof money === 'function') ? money(j.amount) : (j.amount || '');
    return `<div class="list-row" data-pipe-stage="${aesc(stage || '')}" tabindex="0" role="button">
        <div class="list-icon" style="background:${meta.dot}22;color:${meta.dot}">${meta.icon || ''}</div>
        <div class="list-main">
          <div class="list-title">${esc(j.client || t('field_customer'))}</div>
          <div class="list-sub">${esc((meta.label && t(meta.label)) || stage || '')}${j.serviceName ? ' · ' + esc(j.serviceName) : ''}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum">${esc(amt)}</div>
        </div>
      </div>`;
  }

  async function buildDayPanel(dateISO) {
    const rows = await loadBookings(dateISO);
    // If the last active booking of the day runs past midnight, pull
    // tomorrow's first active booking too so the buffer/overlap check can
    // see across the day boundary instead of stopping dead at midnight.
    let nextDayFirst = null;
    const active = rows.filter(r => r.status !== 'cancelled');
    const last = active[active.length - 1];
    if (last && toMin(last.startTime) + n(last.durationMin) >= 1440) {
      const nextRows = await loadBookings(addDays(dateISO, 1));
      nextDayFirst = nextRows.filter(r => r.status !== 'cancelled')[0] || null;
    }
    // Pipeline dots and booking rows are two different domains (sales-stage
    // activity vs. scheduled time slots) — a day can have any mix of the two,
    // including several engagements on the same day, so both render as their
    // own list rather than trying to merge them into one row per client.
    const dayJobs = (typeof jobs !== 'undefined' ? jobs : []).filter(j => j.date === dateISO);
    const both = dayJobs.length > 0 && rows.length > 0;
    const pipelineSection = dayJobs.length
      ? (both ? `<div class="section-title" style="font-size:12px;margin:0 0 6px">${esc(t('pipeline_section_label'))}</div>` : '') +
        `<div class="list-card" style="margin-bottom:${both ? '14px' : '0'}">${dayJobs.map(pipelineDayRowHtml).join('')}</div>`
      : '';
    const bookingSection = rows.length
      ? (both ? `<div class="section-title" style="font-size:12px;margin:0 0 6px">${esc(t('bookings_section_label'))}</div>` : '') + buildDayList(rows, nextDayFirst)
      : '';
    const body = (pipelineSection || bookingSection)
      ? (pipelineSection + bookingSection + scheduleBookingLinkHtml(dateISO))
      : emptyDayHtml(dateISO);
    return `<div class="cal-daypanel">
        <div class="cal-daypanel-head">${esc(dayLabel(dateISO))}</div>
        ${body}
      </div>`;
  }

  // Shared by both views — the segmented Week/Month switch itself never
  // changes shape, only which render function runs underneath it.
  function calModeToggleHtml() {
    return `<div class="cal-mode-switch">
        <button type="button" class="cal-mode-btn${calMode === 'week' ? ' active' : ''}" data-cal-mode="week">${esc(t('cal_mode_week'))}</button>
        <button type="button" class="cal-mode-btn${calMode === 'month' ? ' active' : ''}" data-cal-mode="month">${esc(t('cal_mode_month'))}</button>
      </div>`;
  }
  function wireCalModeToggle(el) {
    el.querySelectorAll('[data-cal-mode]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-cal-mode');
        if (mode === calMode) return;
        calMode = mode;
        await saveSetting('calViewMode', mode);
        renderBookings();
      });
    });
  }

  async function renderBookings() {
    const el = document.getElementById('book-body');
    if (!el) return;
    // Re-sync from `settings` on every render, not just at IIFE-eval time:
    // this file has no boot hook of its own (unlike Pipeline's
    // window.__plView, which enterApp() explicitly refreshes once settings
    // finish loading from IndexedDB) — bookings.js's own module-level
    // `calMode` init above runs at *script-parse* time, before login, when
    // `settings` is still app.js's empty {lang,currency} default. Without
    // this, a value saved in an earlier session would always read back as
    // 'month' on the very first render after a reload. Safe to re-run every
    // time: wireCalModeToggle() always updates `settings.calViewMode` (via
    // saveSetting, which writes it in-memory synchronously) in the same
    // click handler that changes `calMode`, so the two never disagree.
    calMode = (settings && settings.calViewMode === 'week') ? 'week' : 'month';
    if (!selectedDate) selectedDate = todayISO();
    if (!calMonth) calMonth = todayISO().slice(0, 7);
    if (calMode === 'week') { await renderWeekView(el); return; }
    await renderMonthView(el);
  }
  window.renderBookings = renderBookings;

  async function renderWeekView(el) {
    const dates = weekDates(selectedDate);
    let byDate;
    try {
      byDate = await loadWeekBookings(dates);
    } catch (err) {
      console.error('renderWeekView', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>${esc(t('bookings_load_error'))}</p></div>`;
      return;
    }
    const weekNav = `<div class="cal-topnav">
        <button type="button" id="cal-prev" class="cal-navbtn" aria-label="${aesc(t('cal_prev_week_aria'))}">‹</button>
        <button type="button" id="cal-label" class="cal-monthlabel">${esc(weekLabel(dates))}</button>
        <button type="button" id="cal-next" class="cal-navbtn" aria-label="${aesc(t('cal_next_week_aria'))}">›</button>
        <button type="button" id="cal-today-btn" class="cal-todaybtn">${esc(t('cal_today'))}</button>
        <input type="date" id="bk-jump" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">
      </div>`;

    // .wk-scroll is the ONLY horizontal (and, since its content is taller
    // than any reasonable viewport, vertical) scroller — same "one
    // dedicated scroll container, page body never grows past the viewport"
    // rule the Pipeline Gantt's .tl-scroll already established.
    el.innerHTML = `${calModeToggleHtml()}${weekNav}
        <div class="wk-scroll">${wkHeadRowHtml(dates)}${wkBodyRowHtml(dates, byDate)}</div>`;
    wireCalModeToggle(el);

    document.getElementById('cal-prev').addEventListener('click', () => { selectedDate = addDays(selectedDate, -7); renderBookings(); });
    document.getElementById('cal-next').addEventListener('click', () => { selectedDate = addDays(selectedDate, 7); renderBookings(); });
    document.getElementById('cal-today-btn').addEventListener('click', () => { selectedDate = todayISO(); renderBookings(); });
    document.getElementById('cal-label').addEventListener('click', () => {
      const inp = document.getElementById('bk-jump');
      inp.value = selectedDate;
      if (inp.showPicker) inp.showPicker(); else inp.click();
    });
    document.getElementById('bk-jump').addEventListener('change', (e) => {
      if (!e.target.value) return;
      selectedDate = e.target.value;
      renderBookings();
    });
    el.querySelectorAll('[data-bk]').forEach(block => {
      const open = () => openBookingEdit(parseInt(block.getAttribute('data-bk'), 10));
      block.addEventListener('click', open);
      block.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    el.querySelectorAll('[data-wk-cell-date]').forEach(btn => {
      btn.addEventListener('click', () => openBookingForm(btn.getAttribute('data-wk-cell-date'), btn.getAttribute('data-wk-cell-time')));
    });
  }

  async function renderMonthView(el) {
    let bookingDates, stageDates, stagesByDate, dayPanelHtml = '';
    try {
      ({ bookingDates, stageDates, stagesByDate } = await computeActivitySets());
      if (expandedDate) dayPanelHtml = await buildDayPanel(expandedDate);
    } catch (err) {
      console.error('renderBookings', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>${esc(t('bookings_load_error'))}</p></div>`;
      return;
    }

    const monthNav = `<div class="cal-topnav">
        <button type="button" id="cal-prev" class="cal-navbtn" aria-label="${aesc(t('cal_prev_month_aria'))}">‹</button>
        <button type="button" id="cal-label" class="cal-monthlabel">${esc(monthLabel(calMonth))}</button>
        <button type="button" id="cal-next" class="cal-navbtn" aria-label="${aesc(t('cal_next_month_aria'))}">›</button>
        <button type="button" id="cal-today-btn" class="cal-todaybtn">${esc(t('cal_today'))}</button>
        <input type="date" id="bk-jump" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">
      </div>`;

    const WD = [t('wd_mon'), t('wd_tue'), t('wd_wed'), t('wd_thu'), t('wd_fri'), t('wd_sat'), t('wd_sun')];
    const wdRow = `<div class="cal-wd-row">${WD.map(w => `<div class="cal-wd">${w}</div>`).join('')}</div>`;
    const gridDates = monthGridDates(calMonth);
    const grid = `<div class="cal-grid">${buildMonthGrid(gridDates, bookingDates, stagesByDate)}</div>`;

    // Legend only lists what's actually marked somewhere on the visible grid
    // (including its leading/trailing padding days) — no point explaining a
    // stage color the user can't currently see a dot for.
    const isos = gridDates.map(c => c.iso);
    const stageLegendItems = (typeof STAGES !== 'undefined' ? STAGES : [])
      .filter(s => stageDates[s] && isos.some(iso => stageDates[s].has(iso)))
      .map(s => `<span class="cal-legend-item"><span class="cal-dot" style="background:${STAGE_META[s].dot}"></span> ${esc(t(STAGE_META[s].label))}</span>`).join('');
    const bookingLegendItem = isos.some(iso => bookingDates.has(iso))
      ? `<span class="cal-legend-item"><span class="cal-dot cal-dot-book"></span> ${esc(t('booking_word'))}</span>` : '';
    const legend = (stageLegendItems || bookingLegendItem)
      ? `<div class="cal-legend">${stageLegendItems}${bookingLegendItem}</div>` : '';
    const addLabel = expandedDate ? ' · ' + fmtDate(expandedDate) : '';
    // Adding from Calendar creates a pipeline session (same "Add session" job
    // form/modal used from Home/Pipeline's FAB, pre-filled with the selected
    // date), not a separate booking — a calendar day's primary action is
    // logging the work itself, not scheduling a time slot for it.
    const btn = `<button type="button" id="bk-new-btn" class="btn-submit" style="width:100%;margin:14px 0 16px">${esc(t('cal_new_session_btn'))}${esc(addLabel)}</button>`;

    // Two visual columns on desktop (`.cal-layout` grid, see styles.css) so
    // the day panel sits beside the month grid instead of below it — no
    // scrolling needed to see what's on a day after tapping it. On mobile
    // the grid rule doesn't apply and this just stacks top-to-bottom as before.
    const rightPanel = dayPanelHtml || `<div class="empty cal-daypanel-placeholder"><p>${esc(t('cal_tap_day_hint'))}</p></div>`;
    el.innerHTML = `${calModeToggleHtml()}<div class="cal-layout">
        <div class="cal-left">${monthNav}${wdRow}${grid}${legend}${btn}</div>
        <div class="cal-right">${rightPanel}</div>
      </div>`;
    wireCalModeToggle(el);

    document.getElementById('cal-prev').addEventListener('click', () => { calMonth = shiftMonth(calMonth, -1); expandedDate = null; renderBookings(); });
    document.getElementById('cal-next').addEventListener('click', () => { calMonth = shiftMonth(calMonth, 1); expandedDate = null; renderBookings(); });
    document.getElementById('cal-today-btn').addEventListener('click', () => { calMonth = todayISO().slice(0, 7); expandedDate = todayISO(); selectedDate = todayISO(); renderBookings(); });
    document.getElementById('bk-new-btn').addEventListener('click', () => openAddJob(expandedDate || selectedDate || todayISO()));
    // Tapping the month label jumps straight to any date via the native date
    // picker, instead of stepping one month at a time with ‹ › — the hidden
    // input just proxies the picker UI.
    document.getElementById('cal-label').addEventListener('click', () => {
      const inp = document.getElementById('bk-jump');
      inp.value = expandedDate || selectedDate || todayISO();
      if (inp.showPicker) inp.showPicker(); else inp.click();
    });
    document.getElementById('bk-jump').addEventListener('change', (e) => {
      if (!e.target.value) return;
      calMonth = e.target.value.slice(0, 7);
      expandedDate = e.target.value;
      selectedDate = e.target.value;
      renderBookings();
    });

    el.querySelectorAll('[data-cal]').forEach(cell => {
      cell.addEventListener('click', () => {
        const iso = cell.getAttribute('data-cal');
        if (!iso) return;
        if (iso === expandedDate) { expandedDate = null; renderBookings(); return; }
        expandedDate = iso;
        selectedDate = iso;
        if (iso.slice(0, 7) !== calMonth) calMonth = iso.slice(0, 7);
        renderBookings();
      });
    });

    el.querySelectorAll('[data-bk]').forEach(row => {
      const open = () => openBookingEdit(parseInt(row.getAttribute('data-bk'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    // Pipeline rows in the day panel jump to that engagement's stage on the
    // Pipeline board — the calendar itself never edits pipeline data.
    el.querySelectorAll('[data-pipe-stage]').forEach(row => {
      const go = () => { if (typeof openPipelineAt === 'function') openPipelineAt(row.getAttribute('data-pipe-stage')); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }

  function buildDayList(rows, nextDayFirst) {
    // Buffer gaps are computed only between non-cancelled bookings; cancelled
    // ones still render (de-emphasized) but never contribute to a gap. Strips
    // are keyed by the NEXT booking's id (rendered immediately before it) so a
    // cancelled row sitting chronologically between two active ones can't
    // shift the strip onto the wrong pair.
    const active = rows.filter(r => r.status !== 'cancelled');
    const stripsBefore = {}; // nextBookingId -> strip HTML rendered right before that row
    for (let i = 0; i < active.length - 1; i++) {
      const prev = active[i], next = active[i + 1];
      const gap = toMin(next.startTime) - (toMin(prev.startTime) + n(prev.durationMin));
      const buf = n(prev.travelBufferMin);
      if (buf === 0 && gap >= 0) continue; // nothing worth flagging
      stripsBefore[next.id] = (gap < buf) ? stripHtml(true, gap, buf) : stripHtml(false, gap, buf);
    }

    let html = '<div class="list-card">';
    rows.forEach(r => {
      if (stripsBefore[r.id]) html += stripsBefore[r.id];
      html += rowHtml(r);
    });
    // Cross-midnight check: the last active booking here runs past midnight
    // (guaranteed by the renderBookings caller whenever nextDayFirst is set),
    // so compare its end against tomorrow's first booking on the same
    // continuous minutes-since-midnight timeline (+1440).
    if (nextDayFirst && active.length) {
      const last = active[active.length - 1];
      const lastEnd = toMin(last.startTime) + n(last.durationMin);
      const gap = (toMin(nextDayFirst.startTime) + 1440) - lastEnd;
      const buf = n(last.travelBufferMin);
      if (!(buf === 0 && gap >= 0)) {
        const ref = t('cal_tomorrows_booking_ref').replace('{title}', nextDayFirst.title || t('booking_word'));
        html += (gap < buf) ? stripHtml(true, gap, buf, ref) : stripHtml(false, gap, buf, ref);
      }
    }
    html += '</div>';
    return html;
  }

  function stripHtml(warn, gap, buf, refLabel) {
    const suffix = refLabel ? ' ' + t('cal_before_ref').replace('{ref}', refLabel) : '';
    if (warn) {
      const msg = gap < 0
        ? (buf === 0 ? t('cal_overlap_msg').replace('{n}', -gap).replace('{suffix}', suffix)
                     : t('cal_overlap_buffer_msg').replace('{n}', -gap).replace('{suffix}', suffix).replace('{buf}', buf))
        : t('cal_short_gap_msg').replace('{n}', gap).replace('{suffix}', suffix).replace('{buf}', buf);
      return `<div style="padding:7px 16px;font-size:11px;font-weight:700;color:var(--overdue);background:color-mix(in srgb,var(--overdue) 8%,var(--card));border-bottom:0.5px solid var(--border)">${esc('⚠ ' + msg)}</div>`;
    }
    return `<div style="padding:6px 16px;font-size:11px;font-weight:600;color:var(--text3);border-bottom:0.5px solid var(--border)">${esc(t('cal_free_gap_msg').replace('{n}', gap).replace('{suffix}', suffix))}</div>`;
  }

  function rowHtml(r) {
    const dim = (r.status === 'done' || r.status === 'cancelled');
    const start = toMin(r.startTime);
    const end = start + n(r.durationMin);
    const range = fmtMin(start) + '–' + fmtMin(end) + (end >= 1440 ? ' (+1d)' : '');
    const cust = customerName(r.customerId);
    const subParts = [];
    if (cust) subParts.push(esc(cust));
    if (r.location) subParts.push(esc(r.location));
    if (r.status === 'done') subParts.push(esc(t('status_done')));
    if (r.status === 'cancelled') subParts.push(esc(t('status_cancelled')));
    const titleStyle = dim ? ' style="text-decoration:line-through"' : '';
    return `<div class="list-row" data-bk="${r.id}" tabindex="0" role="button"${dim ? ' style="opacity:.55"' : ''}>
        <div class="list-icon" style="font-size:19px;color:var(--brand)">${CAL_SVG}</div>
        <div class="list-main">
          <div class="list-title"${titleStyle}>${esc(r.title || t('booking_word'))}</div>
          <div class="list-sub">${subParts.join(' · ')}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum" style="font-size:14px">${esc(range)}</div>
          <div class="list-amt-sub tnum">${esc(n(r.durationMin) + ' min')}</div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  BOOKING FORM (create / edit)
  // ══════════════════════════════════════════════════════════════════════
  function openBookingForm(dateISO, startTime) {
    editing = null;
    const date = dateISO || selectedDate || todayISO();
    buildFormModal({
      title: t('new_booking_title'),
      customerId: '',
      bkTitle: '',
      date: date,
      startTime: startTime || '09:00',
      durationMin: 60,
      travelBufferMin: 0,
      location: '',
      notes: '',
      status: 'scheduled',
    }, false);
  }
  window.openBookingForm = openBookingForm;

  async function openBookingEdit(id) {
    const b = await dbGet(STORE, id);
    if (!b || b.uid !== uidNow()) { toast(t('booking_not_found')); return; }
    editing = b;
    buildFormModal({
      title: t('edit_booking_title'),
      customerId: b.customerId != null ? b.customerId : '',
      bkTitle: b.title || '',
      date: b.date || todayISO(),
      startTime: b.startTime || '09:00',
      durationMin: b.durationMin != null ? b.durationMin : 60,
      travelBufferMin: b.travelBufferMin != null ? b.travelBufferMin : 0,
      location: b.location || '',
      notes: b.notes || '',
      status: b.status || 'scheduled',
    }, true);
  }

  function buildFormModal(v, isEdit) {
    closeModal('bk-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'bk-form-modal';

    const custOpts = `<option value="">${esc(t('no_client_option'))}</option>` +
      (typeof customers !== 'undefined' ? customers : []).map(c =>
        `<option value="${c.id}"${String(c.id) === String(v.customerId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

    const STATUS_LABEL_KEYS = { scheduled: 'status_scheduled', done: 'status_done', cancelled: 'status_cancelled' };
    const statusOpts = ['scheduled', 'done', 'cancelled'].map(s =>
      `<option value="${s}"${s === v.status ? ' selected' : ''}>${esc(t(STATUS_LABEL_KEYS[s]))}</option>`).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${aesc(t('booking_form_aria'))}">
        <div class="modal-handle"></div>
        <div class="modal-title">${esc(v.title)}</div>
        <div class="form-body">
          <div class="field">
            <label for="bk-cust">${esc(t('field_customer'))}</label>
            <select id="bk-cust">${custOpts}</select>
          </div>
          <div class="field">
            <label for="bk-title">${esc(t('field_title'))}</label>
            <input type="text" id="bk-title" value="${aesc(v.bkTitle)}" placeholder="${aesc(t('bk_title_ph'))}">
          </div>

          <div class="form-header">${esc(t('when_header'))}</div>
          <div class="field">
            <label for="bk-date">${esc(t('field_date'))}</label>
            <input type="date" id="bk-date" value="${aesc(v.date)}">
          </div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="bk-start">${esc(t('start_time_label'))}</label><input type="time" id="bk-start" value="${aesc(v.startTime)}"></div>
            <div class="field-half"><label for="bk-dur">${esc(t('duration_min_label'))}</label><input type="number" id="bk-dur" class="tnum" inputmode="numeric" min="1" step="1" value="${aesc(v.durationMin)}"></div>
          </div>
          <div class="field">
            <label for="bk-buffer">${esc(t('travel_buffer_label'))}</label>
            <input type="number" id="bk-buffer" class="tnum" inputmode="numeric" min="0" step="1" value="${aesc(v.travelBufferMin)}">
          </div>

          <div class="form-header">${esc(t('details_header'))}</div>
          <div class="field">
            <label for="bk-loc">${esc(t('location_label'))}</label>
            <input type="text" id="bk-loc" value="${aesc(v.location)}" placeholder="${aesc(t('location_ph'))}">
          </div>
          <div class="field">
            <label for="bk-status">${esc(t('status_label'))}</label>
            <select id="bk-status">${statusOpts}</select>
          </div>
          <div class="field">
            <label for="bk-notes">${esc(t('field_notes'))}</label>
            <textarea id="bk-notes" rows="2">${esc(v.notes)}</textarea>
          </div>
          ${!isEdit ? (typeof planHasFeature === 'function' && !planHasFeature('recurringBookings') ? `
          <div class="form-header">${esc(t('repeat_header'))}</div>
          <div class="field">
            <label for="bk-repeat">${esc(t('repeat_header'))}</label>
            <select id="bk-repeat" disabled>
              <option value="">${esc(t('repeat_none_option'))}</option>
            </select>
            <p style="font-size:12px;color:var(--text3);margin:6px 0 0">${esc(t('recurring_locked'))}</p>
          </div>` : `
          <div class="form-header">${esc(t('repeat_header'))}</div>
          <div class="field">
            <label for="bk-repeat">${esc(t('repeat_header'))}</label>
            <select id="bk-repeat">
              <option value="">${esc(t('repeat_none_option'))}</option>
              <option value="weekly">${esc(t('repeat_weekly_option'))}</option>
              <option value="biweekly">${esc(t('repeat_biweekly_option'))}</option>
            </select>
          </div>
          <div class="field" id="bk-repeat-until-wrap" style="display:none">
            <label for="bk-repeat-until">${esc(t('repeat_until_label'))}</label>
            <input type="date" id="bk-repeat-until">
          </div>`) : ''}
        </div>
        <button type="button" class="btn-submit" id="bk-save">${isEdit ? esc(t('save_changes_btn')) : esc(t('create_booking_btn'))}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="bk-del">${esc(t('delete_booking_btn'))}</button>` : ''}
        <button type="button" class="btn-danger" id="bk-cancel" style="border-color:var(--border-mid);color:var(--text3)">${esc(t('cancel'))}</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    overlay.querySelector('#bk-save').addEventListener('click', () => saveBooking(isEdit));
    overlay.querySelector('#bk-cancel').addEventListener('click', () => closeModal('bk-form-modal'));
    if (isEdit) overlay.querySelector('#bk-del').addEventListener('click', () => deleteBooking(editing.id));

    const repeatSel = overlay.querySelector('#bk-repeat');
    if (repeatSel) {
      repeatSel.addEventListener('change', () => {
        const wrap = overlay.querySelector('#bk-repeat-until-wrap');
        wrap.style.display = repeatSel.value ? '' : 'none';
      });
    }
  }

  async function saveBooking(isEdit) {
    document.querySelectorAll('#bk-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#bk-form-modal .field-err').forEach(el => el.remove());

    const title = document.getElementById('bk-title').value.trim();
    const date = document.getElementById('bk-date').value;
    const startTime = document.getElementById('bk-start').value;
    const durationMin = Math.round(n(document.getElementById('bk-dur').value));
    const travelBufferMin = Math.max(0, Math.round(n(document.getElementById('bk-buffer').value)));

    // Defense-in-depth alongside the locked/disabled <select> rendered
    // above when the plan doesn't include recurringBookings — a stale
    // render or direct DOM tampering still can't produce extra rows.
    const repeatAllowed = typeof planHasFeature !== 'function' || planHasFeature('recurringBookings');
    const repeatEl = document.getElementById('bk-repeat');
    const repeat = (!isEdit && repeatEl && repeatAllowed) ? repeatEl.value : '';
    const repeatUntilEl = document.getElementById('bk-repeat-until');
    const repeatUntil = repeat ? (repeatUntilEl ? repeatUntilEl.value : '') : '';

    let bad = false;
    if (!title) { markErr('bk-title', t('err_enter_booking_title')); bad = true; }
    if (!date) { markErr('bk-date', t('err_pick_date')); bad = true; }
    if (!startTime) { markErr('bk-start', t('err_pick_start_time')); bad = true; }
    if (!(durationMin > 0)) { markErr('bk-dur', t('err_duration_min')); bad = true; }
    if (repeat) {
      if (!repeatUntil) { markErr('bk-repeat-until', t('err_repeat_end_date')); bad = true; }
      else if (repeatUntil < date) { markErr('bk-repeat-until', t('err_repeat_end_after')); bad = true; }
    }
    if (bad) return;

    const uid = uidNow();
    const custVal = document.getElementById('bk-cust').value;
    const base = {
      uid,
      customerId: custVal ? parseInt(custVal, 10) : null,
      title,
      date,
      startTime,
      durationMin,
      travelBufferMin,
      location: document.getElementById('bk-loc').value.trim(),
      notes: document.getElementById('bk-notes').value.trim(),
      status: document.getElementById('bk-status').value || 'scheduled',
      updatedAt: nowISO(),
    };

    let extraCount = 0;
    try {
      const mirrorEnabled = !isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled();
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        base.createdAt = editing.createdAt || nowISO();
        base.jobCuid = editing.jobCuid ?? null;   // keep a gate-created booking linked to its pipeline job through form edits
        await dbPut(STORE, base);
        if (mirrorEnabled) SidekickBackend.mirrorBookingSave(base).catch(() => {});
        toast(t('booking_updated'));
      } else {
        base.cuid = cuid();
        base.createdAt = nowISO();
        base.jobCuid = null;   // form-created bookings have no pipeline-job link (only createBookingForStep sets one)
        await dbAdd(STORE, base);
        if (mirrorEnabled) SidekickBackend.mirrorBookingSave(base).catch(() => {});

        if (repeat) {
          const stepDays = repeat === 'biweekly' ? 14 : 7;
          let nextDate = addDays(date, stepDays);
          while (nextDate <= repeatUntil && extraCount < MAX_REPEAT_OCCURRENCES) {
            const row = { ...base, date: nextDate, cuid: cuid(), createdAt: nowISO(), updatedAt: nowISO() };
            delete row.id;
            await dbAdd(STORE, row);
            if (mirrorEnabled) SidekickBackend.mirrorBookingSave(row).catch(() => {});
            extraCount++;
            nextDate = addDays(nextDate, stepDays);
          }
        }
        toast(extraCount > 0 ? t('booking_created_series').replace('{n}', extraCount) : t('booking_created'));
      }
    } catch (err) {
      console.error(err);
      toast(t('booking_save_failed'));
      return;
    }
    // Follow the booking to its (possibly changed) day: expand that date's
    // panel and jump the grid to its month so the saved booking is visible.
    selectedDate = date;
    expandedDate = date;
    calMonth = date.slice(0, 7);
    closeModal('bk-form-modal');
    renderBookings();
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

  async function deleteBooking(id) {
    if (!confirm(t('delete_booking_confirm'))) return;
    try {
      const prev = await dbGet(STORE, id);
      await dbDel(STORE, id);
      if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
        SidekickBackend.mirrorBookingDelete(prev.cuid).catch(() => {});
      }
    } catch (e) {
      console.error(e);
      toast(t('delete_failed'));
      return;
    }
    closeModal('bk-form-modal');
    toast(t('booking_deleted'));
    renderBookings();
  }

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

})();
