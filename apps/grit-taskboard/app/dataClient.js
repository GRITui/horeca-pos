/* Sidekick — app/dataClient.js
 *
 * Phase 1 of the local-first -> backend migration, extended in Phase 2b to
 * the 11 more stores Phase 2 fanned crudHandler out to server-side. Still
 * deliberately a MIRROR, not a replacement: local IndexedDB stays every
 * registered account's one source of truth for reads AND writes in this
 * phase (exactly as it is for guest mode, unchanged) — this file only
 * pushes a best-effort copy of writes to the new backend alongside the
 * existing local write, plus the one-time bulk upload of whatever already
 * exists locally (clients only, so far).
 *
 * Phase 2b's mirror calls are wired into each store's main Save/Delete
 * action only (saveJob/deleteJob, saveInvoice/deleteInvoice, ...) — NOT
 * into every granular in-place mutation a record can go through (a job's
 * Pipeline stage move, a milestone/sub-task/timer edit, a persona-tracker
 * field tweak on a client, ...). That's the same scope boundary Phase 1
 * already drew for `clients` (saveCustomer/deleteCustomer mirror; the
 * persona-tracker helpers that edit a client in place, e.g.
 * saveClientListItemField(), do not) — the mirror covers the record as it
 * stood at its last full save, not a live replica of every subsequent edit.
 *
 * Why mirror instead of cutting reads over now: every other IndexedDB
 * store (jobs, packages, progressLogs, ...) references a client by its
 * local autoincrement `id` (job.clientId, package.clientId, ...), not by
 * `cuid`. Making `clients` backend-authoritative in Phase 1 would mean
 * abandoning that local `id` as the addressing key everywhere it's
 * referenced — a much bigger, cross-store change than this slice is
 * scoped for. Mirroring by `cuid` (which every clients record already
 * carries) sidesteps that entirely: local `id` keeps meaning exactly what
 * it always has, for every store that isn't part of this migration yet.
 * Cutting `clients` reads over to the server is explicitly Phase 4, once
 * Phase 2/3 have fanned this same pattern out to the stores that reference
 * a client by id and migrated those references too.
 *
 * No build step, so this loads as a plain classic <script> (not a module)
 * — see index.html, loaded once before app.js. Exposes one global,
 * `SidekickBackend`, rather than free-floating function names, so it reads
 * clearly at every call site in app.js that this is the backend-mirror
 * layer, not another local helper.
 */
(function () {
  // Same-origin as the app in local dev (python http.server serving app/),
  // cross-origin (GitHub Pages -> Vercel) in production — see lib/cors.js
  // for the allowlist this API enforces on the other end. Overridable via
  // window.__SIDEKICK_API_BASE for tests/local dev against `vercel dev`.
  const API_BASE = window.__SIDEKICK_API_BASE || 'https://sidekickz.vercel.app';
  const TOKEN_KEY = 'sidekick_backend_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function apiFetch(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) return { ok: false, status: 401, data: { error: 'Not signed in to cloud backup' } };
      headers.authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method, headers, body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, data: { error: 'Network error — could not reach the cloud backup service' } };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  async function register({ username, salt, hash, iters, firstName }) {
    const r = await apiFetch('/api/auth-register', { method: 'POST', auth: false, body: { username, salt, hash, iters, firstName } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  async function login({ username, password }) {
    const r = await apiFetch('/api/auth-login', { method: 'POST', auth: false, body: { username, password } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  // LINE-authenticated accounts have no password — see api/auth-register-
  // line.js's header for why this is a separate call from register().
  async function registerLine(lineToken) {
    const r = await apiFetch('/api/auth-register-line', { method: 'POST', auth: false, body: { lineToken } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  async function session() {
    if (!getToken()) return { ok: false, status: 401, data: {} };
    return apiFetch('/api/auth-session');
  }
  function logout() { clearToken(); }
  function isEnabled() { return !!getToken(); }

  // ── Billing (Phase 0) ────────────────────────────────────────────────
  // Both just hand back a Stripe-hosted URL for the caller to redirect to
  // — see api/billing-checkout.js/api/billing-portal.js for why nothing
  // card-related is ever built or handled client-side here.
  async function billingCheckout(plan) {
    return apiFetch('/api/billing-checkout', { method: 'POST', body: { plan } });
  }
  async function billingPortal() {
    return apiFetch('/api/billing-portal', { method: 'POST' });
  }

  // ── LINE business connection + booking slots (generic multi-tenant) ────
  // See api/line-channel-connect.js/api/booking-slots.js — this account's
  // own LINE Official Account connection and the time windows it offers up
  // on its public booking page (app/book.html).
  async function lineChannelStatus() {
    return apiFetch('/api/line-channel-connect');
  }
  async function lineChannelConnect({ channelId, channelSecret, freelancerLineUserId }) {
    return apiFetch('/api/line-channel-connect', { method: 'POST', body: { channelId, channelSecret, freelancerLineUserId } });
  }
  async function lineChannelDisconnect() {
    return apiFetch('/api/line-channel-connect', { method: 'DELETE' });
  }
  async function bookingSlotsList() {
    return apiFetch('/api/booking-slots');
  }
  async function bookingSlotCreate({ startsAt, endsAt }) {
    return apiFetch('/api/booking-slots', { method: 'POST', body: { startsAt, endsAt } });
  }
  async function bookingSlotDelete(id) {
    return apiFetch(`/api/booking-slots?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  // Pending public booking requests + their confirm/decline resolution —
  // the freelancer side of api/booking-request.js's 15-minute holds (see
  // api/booking-requests.js).
  async function bookingRequestsList() {
    return apiFetch('/api/booking-requests');
  }
  async function bookingRequestResolve(bookingId, action) {
    return apiFetch('/api/booking-requests', { method: 'POST', body: { bookingId, action } });
  }
  // Pass M3-L3: pending public storefront order requests + their
  // confirm/decline resolution — the freelancer side of api/shop-public.js's
  // POST writes. Exact copy of bookingRequestsList/bookingRequestResolve
  // above (same auth headers, same error shape) — see api/order-requests.js
  // for the server side.
  async function orderRequestsList() {
    return apiFetch('/api/order-requests');
  }
  async function orderRequestResolve(id, action) {
    return apiFetch('/api/order-requests', { method: 'POST', body: { id, action } });
  }

  // ── Team (Phase 2) ──────────────────────────────────────────────────────
  // See api/team-invite.js/api/team-join.js/api/team-members.js — a Team
  // plan's shared-single-identity org: the owner's own data, with other
  // accounts (admin/staff) granted access to it.
  async function teamCheckout(seats) {
    return apiFetch('/api/billing-checkout', { method: 'POST', body: { plan: 'team', seats } });
  }
  async function teamInvite(role) {
    return apiFetch('/api/team-invite', { method: 'POST', body: { role } });
  }
  async function teamJoin(token) {
    return apiFetch('/api/team-join', { method: 'POST', body: { token } });
  }
  async function teamMembersList() {
    return apiFetch('/api/team-members');
  }
  async function teamMemberRemove(memberCuid) {
    return apiFetch(`/api/team-members?memberCuid=${encodeURIComponent(memberCuid)}`, { method: 'DELETE' });
  }

  // Numeric/integer/decimal columns come back over the wire as whatever
  // res.json() gave them — a Postgres `numeric`/`text`-holding-a-number
  // column round-trips as a JS string via Neon's serverless driver, not a
  // number — so every reverse map below runs id/amount-shaped fields
  // through this rather than handing the raw string to app.js code that
  // does real arithmetic (netOf(), stage-cap comparisons, ...) on it.
  function num(v) { return v == null || v === '' ? null : Number(v); }

  // 2026-07-16: resolves a local id-ref (job.clientId, invoice.clientId, ...)
  // to the cuid of the row it points at, AT MIRROR TIME — this is what lets
  // pullAll()/importDataset() (app.js) resolve the link by cuid on another
  // device instead of nulling it, since the local autoincrement id this
  // device minted means nothing anywhere else (see this file's own header
  // and sql/schema-core.sql's ref-cuid comment). `dbGet` is app.js's
  // IndexedDB helper — a classic-script global, not something this file
  // imports, hence the `typeof` guard (defensive; app.js always loads before
  // this file per index.html's script order, but there's no reason to trust
  // that here). Every failure mode (no id, missing row, a lookup that throws)
  // resolves to null rather than propagating — a best-effort mirror should
  // never fail the whole save over an unresolved ref.
  async function refCuid(store, id) {
    if (id == null || typeof dbGet !== 'function') return null;
    try {
      const row = await dbGet(store, id);
      return (row && row.cuid) || null;
    } catch (e) {
      return null;
    }
  }

  // ── clients mirror ────────────────────────────────────────────────────
  // Always tries create first; a 409 (this cuid already exists server-side
  // — e.g. this record was already uploaded, or already mirrored from a
  // previous save) falls back to an update. Fire-and-forget from the
  // caller's point of view: local IndexedDB is already the write of
  // record by the time this runs, so a failure here just means this one
  // record's cloud copy is stale until the next save or the next full
  // migrateUpload() — it never blocks or reverts the local save.
  function toClientPayload(c) {
    return {
      cuid: c.cuid, name: c.name, phone: c.phone, email: c.email, tags: c.tags,
      notes: c.notes, tax_id: c.taxId, billing_address: c.billingAddress, member_no: c.memberNo,
    };
  }
  // Reverse of toClientPayload() above, kept right below it so any column
  // added to one is obviously missing from the other. Deliberately does NOT
  // reconstruct a local `id` — a client's own local autoincrement id was
  // never part of the mirror payload (only its cuid), so pullAll() can't
  // hand one back either. See pullAll()'s header for what that means for
  // id-based cross-references (jobs.clientId etc.) on a cloud restore.
  function fromClientRow(row) {
    return {
      cuid: row.cuid, name: row.name, phone: row.phone, email: row.email, tags: row.tags,
      notes: row.notes, taxId: row.tax_id, billingAddress: row.billing_address, memberNo: row.member_no,
    };
  }
  async function mirrorClientSave(c) {
    if (!isEnabled() || !c.cuid) return;
    const payload = toClientPayload(c);
    const created = await apiFetch('/api/clients', { method: 'POST', body: payload });
    if (created.ok || created.status !== 409) return;
    await apiFetch(`/api/clients?cuid=${encodeURIComponent(c.cuid)}`, { method: 'PUT', body: payload });
  }
  async function mirrorClientDelete(cuid) {
    if (!isEnabled() || !cuid) return;
    await apiFetch(`/api/clients?cuid=${encodeURIComponent(cuid)}`, { method: 'DELETE' });
  }

  // ── one-time bulk upload (existing local data, or a guest converting) ──
  async function migrateUpload(clients) {
    return apiFetch('/api/migrate-upload', { method: 'POST', body: { clients: clients.map(toClientPayload) } });
  }

  // ── Phase 2b: mirror wiring for the 11 stores Phase 2 fanned crudHandler
  // out to (schema + API only, no client-side wiring) ───────────────────
  // Same create-then-fallback-to-update shape as mirrorClientSave/
  // mirrorClientDelete above, generalized so each of the 9 more cuid-keyed
  // stores below doesn't hand-roll the same fetch dance. `packages` gets a
  // save mirror even though nothing in app.js currently deletes a package
  // (no delete call site exists yet) — for parity/future use, harmless
  // either way since mirrorDelete is simply never called for it today.
  //
  // 2026-07-16: `toPayload` is `await`ed here rather than called for its
  // return value directly — every affected store's toPayload (jobs,
  // invoices, documents, packages, progressLogs, bookings) now resolves its
  // id-refs to ref cuids via refCuid() above, which is async (an IndexedDB
  // lookup). Every caller of mirrorSave/mirrorDelete across app.js/
  // bookings.js/invoices.js/docgen.js already treats the call as
  // fire-and-forget (`SidekickBackend.mirrorXSave(record).catch(() => {})`)
  // and never inspected toPayload's return value directly, so making this
  // function's internals async doesn't change any call site — verified via
  // grep across app/*.js before this change.
  function createMirror(apiPath, toPayload) {
    async function mirrorSave(record) {
      if (!isEnabled() || !record || !record.cuid) return;
      const payload = await toPayload(record);
      const created = await apiFetch(`/api/${apiPath}`, { method: 'POST', body: payload });
      if (created.ok || created.status !== 409) return;
      await apiFetch(`/api/${apiPath}?cuid=${encodeURIComponent(record.cuid)}`, { method: 'PUT', body: payload });
    }
    async function mirrorDelete(recordCuid) {
      if (!isEnabled() || !recordCuid) return;
      await apiFetch(`/api/${apiPath}?cuid=${encodeURIComponent(recordCuid)}`, { method: 'DELETE' });
    }
    return { mirrorSave, mirrorDelete };
  }

  const jobsMirror = createMirror('jobs', async j => ({
    cuid: j.cuid, date: j.date, client_name: j.client, client_id: j.clientId,
    service_id: j.serviceId, service_name: j.serviceName, job_type: j.jobType,
    amount: j.amount, tip: j.tip, expense: j.expense, count: j.count, notes: j.notes,
    net_amount: j.netAmount, stage_order: j.stageOrder, stage: j.stage, complete: j.complete,
    invoice_id: j.invoiceId, quote_doc_id: j.quoteDocId, package_id: j.packageId,
    sub_tasks: j.subTasks, milestones: j.milestones, time_entries: j.timeEntries,
    timer_started_at: j.timerStartedAt,
    // 2026-07-17: restore-fidelity fix — these were missing from the
    // mirror entirely, so a lost job restored from cloud came back
    // outcome=null (silently counting as a successful completed
    // engagement) and its options list vanished.
    outcome: j.outcome, lost_reason: j.lostReason, pending_gate_stage: j.pendingGateStage, options: j.options,
    // 2026-07-17: Pass M3-L2 — engagement items (products/extra services
    // attached to a pipeline job) follow the same jsonb-embedded-array
    // convention as options/subTasks/milestones above.
    items: j.items,
    // 2026-07-16: ref cuids for the id-refs above — see refCuid()'s comment.
    // milestones[]/timeEntries[]'s own embedded invoiceId is NOT resolved
    // here (accepted residual gap, see app.js importDataset()'s comment) —
    // only the job's own top-level refs get this treatment this pass.
    client_cuid: await refCuid('clients', j.clientId),
    service_cuid: await refCuid('services', j.serviceId),
    invoice_cuid: await refCuid('invoices', j.invoiceId),
    quote_doc_cuid: await refCuid('documents', j.quoteDocId),
    package_cuid: await refCuid('packages', j.packageId),
  }));
  // Reverse of the toPayload above. `stage_order`/`sub_tasks`/`milestones`/
  // `time_entries` are jsonb columns — they arrive already parsed into
  // plain arrays/objects by res.json(), not as JSON strings needing a
  // second parse. `clientId`/`serviceId`/`invoiceId`/`quoteDocId`/
  // `packageId` come back as the numeric local id the mirroring device had
  // for that row at save time — see fromClientRow()'s comment; importDataset()
  // (app.js) already treats an id it can't resolve within the same restore
  // batch as "target missing" and nulls it, same as a file-based restore
  // whose backup is missing a referenced row. `__clientCuid`/`__serviceCuid`/
  // `__invoiceCuid`/`__quoteDocCuid`/`__packageCuid` are transient fields
  // (double-underscore = never rendered anywhere, stripped by importDataset()
  // before insert) that carry the ref cuids through so importDataset() can
  // try resolving each ref by cuid FIRST, before falling back to the same-
  // file oldId map.
  function fromJobRow(row) {
    return {
      cuid: row.cuid, date: row.date, client: row.client_name, clientId: num(row.client_id),
      serviceId: num(row.service_id), serviceName: row.service_name, jobType: row.job_type,
      amount: num(row.amount), tip: num(row.tip), expense: num(row.expense), count: num(row.count),
      notes: row.notes, netAmount: num(row.net_amount), stageOrder: row.stage_order, stage: row.stage,
      complete: row.complete, invoiceId: num(row.invoice_id), quoteDocId: num(row.quote_doc_id),
      packageId: num(row.package_id), subTasks: row.sub_tasks, milestones: row.milestones,
      timeEntries: row.time_entries, timerStartedAt: row.timer_started_at,
      outcome: row.outcome, lostReason: row.lost_reason, pendingGateStage: row.pending_gate_stage, options: row.options,
      items: row.items,
      __clientCuid: row.client_cuid || null, __serviceCuid: row.service_cuid || null,
      __invoiceCuid: row.invoice_cuid || null, __quoteDocCuid: row.quote_doc_cuid || null,
      __packageCuid: row.package_cuid || null,
    };
  }

  // 2026-07-17: Pass M3-L1 — unify Services into a product/service catalog.
  // `kind`/`sku` ride through as plain strings; `stock_qty`/`cost` go
  // through num() on the way back (numeric columns round-trip as strings —
  // see num()'s own comment above).
  const servicesMirror = createMirror('services', s => ({
    cuid: s.cuid, name: s.name, rate: s.rate, unit: s.unit, usage_qty: s.usageQty,
    kind: s.kind, sku: s.sku, stock_qty: s.stockQty, cost: s.cost,
  }));
  function fromServiceRow(row) {
    return {
      cuid: row.cuid, name: row.name, rate: num(row.rate), unit: row.unit, usageQty: num(row.usage_qty),
      kind: row.kind, sku: row.sku, stockQty: num(row.stock_qty), cost: num(row.cost),
    };
  }

  const invoicesMirror = createMirror('invoices', async i => ({
    cuid: i.cuid, number: i.number, issue_date: i.issueDate, due_date: i.dueDate,
    client_id: i.clientId, client_name: i.clientName, client_tax_id: i.clientTaxId,
    client_address: i.clientAddress, line_items: i.lineItems, subtotal: i.subtotal,
    wht_pct: i.whtPct, vat_pct: i.vatPct, vat: i.vat, wht: i.wht,
    client_pays: i.clientPays, you_receive: i.youReceive, deposit_pct: i.depositPct,
    status: i.status, payment_channels: i.paymentChannels, notes: i.notes,
    // 2026-07-17: embedded slip array (Pass M2a) — see sql/schema-core.sql.
    slips: i.slips,
    // 2026-07-17: Pass M3-L1 — stamped once a paid invoice's product lines
    // decrement catalog stock (app.js decrementStockForInvoicePaid), text
    // like the local nowISO() value it carries (not a parsed timestamp).
    // NOTE: api/invoices.js's FIELDS whitelist is outside this pass's
    // writable set, so this column is not yet persisted server-side — the
    // local IndexedDB stamp (the one that actually guards double-decrement)
    // is unaffected either way; see this pass's own report for the caveat.
    stock_decremented_at: i.stockDecrementedAt,
    // 2026-07-16: ref cuid for client_id — see refCuid()'s comment.
    client_cuid: await refCuid('clients', i.clientId),
  }));
  // `line_items`/`payment_channels`/`slips` are jsonb — already-parsed
  // arrays/objects, same as jobs' jsonb columns above. `__clientCuid` is a
  // transient field (see fromJobRow's comment) carrying client_cuid through
  // for importDataset() to resolve by cuid first.
  function fromInvoiceRow(row) {
    return {
      cuid: row.cuid, number: row.number, issueDate: row.issue_date, dueDate: row.due_date,
      clientId: num(row.client_id), clientName: row.client_name, clientTaxId: row.client_tax_id,
      clientAddress: row.client_address, lineItems: row.line_items, subtotal: num(row.subtotal),
      whtPct: num(row.wht_pct), vatPct: num(row.vat_pct), vat: num(row.vat), wht: num(row.wht),
      clientPays: num(row.client_pays), youReceive: num(row.you_receive), depositPct: num(row.deposit_pct),
      status: row.status, paymentChannels: row.payment_channels, notes: row.notes, slips: row.slips,
      stockDecrementedAt: row.stock_decremented_at,
      __clientCuid: row.client_cuid || null,
    };
  }

  // Pass M2b: fetches this account's own SERVER copy of one invoice by
  // cuid, for openInvoiceDetail()'s slip merge-back (app/invoices.js) — a
  // client can attach a slip straight through the public invoice page
  // (app/invoice.html → api/invoice-public.js), which lands on the server
  // row only; this is what lets the freelancer's local copy pick it up.
  // No ?cuid= filter on the invoices GET (lib/crudHandler.js only supports
  // that on PUT/DELETE, not GET — see its `url.searchParams.get('cuid')`
  // usage) so this fetches the full authenticated list like pullAll() does
  // and picks the one row client-side. Returns null on any failure
  // (not-found, network, auth) — callers are expected to swallow that
  // silently (a background sync failing is not user-facing).
  async function invoiceFetchByCuid(cuid) {
    const r = await apiFetch('/api/invoices');
    if (!r.ok || !Array.isArray(r.data.rows)) return null;
    const row = r.data.rows.find(x => x.cuid === cuid);
    return row ? fromInvoiceRow(row) : null;
  }

  const documentsMirror = createMirror('documents', async d => ({
    cuid: d.cuid, type: d.type, title: d.title, client_id: d.clientId,
    client_name: d.clientName, invoice_id: d.invoiceId, fields: d.fields,
    content: d.content, number: d.number, issue_date: d.issueDate,
    // 2026-07-16: ref cuids for client_id/invoice_id — see refCuid()'s comment.
    client_cuid: await refCuid('clients', d.clientId),
    invoice_cuid: await refCuid('invoices', d.invoiceId),
  }));
  // `__clientCuid`/`__invoiceCuid` are transient fields (see fromJobRow's
  // comment) carrying the ref cuids through for importDataset().
  function fromDocumentRow(row) {
    return {
      cuid: row.cuid, type: row.type, title: row.title, clientId: num(row.client_id),
      clientName: row.client_name, invoiceId: num(row.invoice_id), fields: row.fields,
      content: row.content, number: row.number, issueDate: row.issue_date,
      __clientCuid: row.client_cuid || null, __invoiceCuid: row.invoice_cuid || null,
    };
  }

  // Local IndexedDB store is still named 'bookings' (app/bookings.js) — the
  // api-path/table rename to app_bookings/app-bookings.js is a backend-only
  // detail to avoid colliding with the LINE pilot's own `bookings` table
  // (see sql/schema-core.sql), not something the client needs to know about.
  const bookingsMirror = createMirror('app-bookings', async b => ({
    cuid: b.cuid, customer_id: b.customerId, title: b.title, date: b.date,
    start_time: b.startTime, duration_min: b.durationMin, travel_buffer_min: b.travelBufferMin,
    location: b.location, notes: b.notes, status: b.status,
    job_cuid: b.jobCuid,
    // 2026-07-16: ref cuid for customer_id — see refCuid()'s comment.
    customer_cuid: await refCuid('clients', b.customerId),
  }));
  // `job_cuid` rides through untouched (it's a cuid, not a local id — same
  // "cuid-based links never get remapped" rule importDataset()'s IMPORT_ORDER
  // loop already follows for subTasks[].bookingCuid). `__customerCuid` is a
  // transient field (see fromJobRow's comment) carrying customer_cuid through
  // for importDataset().
  function fromBookingRow(row) {
    return {
      cuid: row.cuid, customerId: num(row.customer_id), title: row.title, date: row.date,
      startTime: row.start_time, durationMin: num(row.duration_min), travelBufferMin: num(row.travel_buffer_min),
      location: row.location, notes: row.notes, status: row.status, jobCuid: row.job_cuid,
      __customerCuid: row.customer_cuid || null,
    };
  }

  const followupsMirror = createMirror('followups', f => ({
    cuid: f.cuid, key: f.key, dismissed: f.dismissed, snoozed_until: f.snoozedUntil,
  }));
  // `key` embeds ids as a string (`overdue:CID:INVID`, ...) — left as-is,
  // same as bookings' job_cuid above; importDataset()'s followups branch is
  // what rewrites the embedded numbers, not this map.
  function fromFollowupRow(row) {
    return { cuid: row.cuid, key: row.key, dismissed: row.dismissed, snoozedUntil: row.snoozed_until };
  }

  // Local field is `order` (app/portfolio.js), not `orderIndex` — mapped to
  // the schema's `order_index` column name here, at the boundary.
  const portfolioMirror = createMirror('portfolio', p => ({
    cuid: p.cuid, title: p.title, description: p.description, tags: p.tags,
    image_data_url: p.imageDataUrl, order_index: p.order,
  }));
  function fromPortfolioRow(row) {
    return {
      cuid: row.cuid, title: row.title, description: row.description, tags: row.tags,
      imageDataUrl: row.image_data_url, order: num(row.order_index),
    };
  }

  const researchMirror = createMirror('research', r => ({
    cuid: r.cuid, title: r.title, category: r.category, body: r.body, is_premium: r.isPremium,
  }));
  function fromResearchRow(row) {
    return { cuid: row.cuid, title: row.title, category: row.category, body: row.body, isPremium: row.is_premium };
  }

  const packagesMirror = createMirror('packages', async p => ({
    cuid: p.cuid, client_id: p.clientId, total_sessions: p.totalSessions, price: p.price,
    purchased_date: p.purchasedDate, expires_at: p.expiresAt, notes: p.notes,
    // 2026-07-16: ref cuid for client_id — see refCuid()'s comment.
    client_cuid: await refCuid('clients', p.clientId),
  }));
  // `__clientCuid` is a transient field (see fromJobRow's comment) carrying
  // client_cuid through for importDataset().
  function fromPackageRow(row) {
    return {
      cuid: row.cuid, clientId: num(row.client_id), totalSessions: num(row.total_sessions), price: num(row.price),
      purchasedDate: row.purchased_date, expiresAt: row.expires_at, notes: row.notes,
      __clientCuid: row.client_cuid || null,
    };
  }

  const progressLogsMirror = createMirror('progress-logs', async p => ({
    cuid: p.cuid, client_id: p.clientId, date: p.date, weight: p.weight, notes: p.notes,
    // 2026-07-16: ref cuid for client_id — see refCuid()'s comment.
    client_cuid: await refCuid('clients', p.clientId),
  }));
  function fromProgressLogRow(row) {
    return {
      cuid: row.cuid, clientId: num(row.client_id), date: row.date, weight: num(row.weight), notes: row.notes,
      __clientCuid: row.client_cuid || null,
    };
  }

  // Bespoke, not createMirror(): api/settings.js's row key is (user_cuid,
  // key), no cuid at all (see that file's own header for why). The local
  // IndexedDB 'settings' store multiplexes every local account's rows in
  // one store via a uid-prefixed key (e.g. 'guest:lang' or '3:lang') — the
  // server row is already scoped per-account by the bearer session, so the
  // prefix is stripped before mirroring rather than sent verbatim.
  async function mirrorSettingSave(prefixedKey, value) {
    if (!isEnabled()) return;
    const sep = prefixedKey.indexOf(':');
    const bareKey = sep >= 0 ? prefixedKey.slice(sep + 1) : prefixedKey;
    await apiFetch(`/api/settings?key=${encodeURIComponent(bareKey)}`, { method: 'PUT', body: { value } });
  }

  // ── pullAll(): the other half of the mirror — closes both "cloud restore
  // path" and "Team read cutover" at once ──────────────────────────────────
  // Every resource endpoint's GET (lib/crudHandler.js) already scopes its
  // rows by resolveDataOwner(), not the caller's own cuid (lib/teams.js) —
  // so a team member's GET already comes back as the ORG OWNER's rows, no
  // extra server work needed. That means "restore this device from the
  // cloud" (solo account, after a wipe/reinstall) and "let a team member see
  // the owner's data" (Team plan, Phase 2) are the exact same client-side
  // operation: fetch every resource, reshape each row back to the local
  // record shape, and hand the whole batch to importDataset() (app.js) —
  // which was already built, and is already id-remap-tested, for the
  // file-based restore. This function is purely that fetch-and-reshape; it
  // does not touch IndexedDB itself (app.js's restoreFromCloud() does).
  //
  // Deliberately excludes 'expenses': that local IndexedDB store has no
  // server-side table/endpoint at all (see BACKUP_STORES in app.js and this
  // file's own header on why `clients` was the only store Phase 1 mirrored,
  // since fanned out but never to expenses) — there is nothing to pull for
  // it, and it must stay OUT of the returned byStore entirely (not present
  // as an empty array) so importDataset() leaves this device's expenses
  // rows untouched rather than wiping them on every cloud restore.
  //
  // All GETs run in parallel and are independently fault-tolerant: one
  // store's fetch failing (a transient 502, a locked/misconfigured server)
  // is reported via `failed` rather than discarding the stores that did
  // come back successfully.
  const PULL_RESOURCES = [
    ['clients', 'clients', fromClientRow],
    ['jobs', 'jobs', fromJobRow],
    ['services', 'services', fromServiceRow],
    ['invoices', 'invoices', fromInvoiceRow],
    ['documents', 'documents', fromDocumentRow],
    ['bookings', 'app-bookings', fromBookingRow],
    ['followups', 'followups', fromFollowupRow],
    ['portfolio', 'portfolio', fromPortfolioRow],
    ['research', 'research', fromResearchRow],
    ['packages', 'packages', fromPackageRow],
    ['progressLogs', 'progress-logs', fromProgressLogRow],
  ];
  async function pullAll() {
    if (!isEnabled()) return { ok: false, byStore: {}, settingsRows: [], failed: [] };
    const [resourceResults, settingsResult] = await Promise.all([
      Promise.all(PULL_RESOURCES.map(([, apiPath]) => apiFetch(`/api/${apiPath}`))),
      apiFetch('/api/settings'),
    ]);
    const byStore = {};
    const failed = [];
    PULL_RESOURCES.forEach(([storeName, , toLocal], idx) => {
      const r = resourceResults[idx];
      if (r.ok && Array.isArray(r.data.rows)) byStore[storeName] = r.data.rows.map(toLocal);
      else failed.push(storeName);
    });
    const settingsOk = settingsResult.ok && Array.isArray(settingsResult.data.rows);
    if (!settingsOk) failed.push('settings');
    // ok=false only when NOTHING came back usable (e.g. an invalid/expired
    // token failing every request identically) — a partial failure still
    // returns ok=true with byStore holding whatever did succeed, so the
    // caller can still hydrate most of the account's data and just say so.
    return {
      ok: failed.length < PULL_RESOURCES.length + 1,
      byStore,
      settingsRows: settingsOk ? settingsResult.data.rows : [],
      failed,
    };
  }

  // ── Ops board (Grit BizSuite pivot) ─────────────────────────────────────
  // Screen-scoped sync, NOT part of pullAll()'s once-per-restore
  // BACKUP_STORES flow above — app/opsboard.js pulls fresh from the server
  // every time its screen opens, merging server-wins on `id`, rather than
  // folding into the account-wide cloud-restore path. Reuses this file's
  // apiFetch()/token plumbing (the "reuse SidekickBackend" branch of
  // opsboard.js's own documented sync-layer choice) instead of a second,
  // parallel fetch/token implementation living in opsboard.js — this file
  // is already the one place every other endpoint's fetch/auth/error shape
  // lives, and ops_tasks fits that same shape (bearer token, JSON body,
  // {ok,status,data}) with no bespoke wrinkle that would justify going
  // around it.
  //
  // Wire format is snake_case (id/location_id/title/.../assigned_shift),
  // matching every other resource endpoint's `select *` pass-through
  // convention (see lib/crudHandler.js) — NOT the camelCase-mapped shape
  // toClientPayload/fromClientRow etc. use above, since ops_tasks has no
  // separate local-autoincrement-id-vs-cuid split to bridge (its `id` IS
  // the stable identity on both sides, see app/app.js's opsTasks store
  // comment) — a straight snake_case<->camelCase field rename is all that's
  // needed, done here in toOpsTaskPayload/fromOpsTaskRow.
  function toOpsTaskPayload(t) {
    return {
      id: t.id, location_id: t.locationId, title: t.title, description: t.description,
      status: t.status, priority: t.priority, assigned_shift: t.assignedShift,
    };
  }
  function fromOpsTaskRow(row) {
    return {
      id: row.id, locationId: row.location_id, title: row.title, description: row.description,
      status: row.status, priority: row.priority, triggeredBy: row.triggered_by,
      assignedShift: row.assigned_shift, sourceEventId: row.source_event_id,
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    };
  }
  async function opsTasksList(params) {
    const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
    const r = await apiFetch(`/api/ops-tasks${qs}`);
    return { ok: r.ok, status: r.status, rows: r.ok && Array.isArray(r.data.rows) ? r.data.rows.map(fromOpsTaskRow) : [] };
  }
  async function opsTaskCreate(t) {
    const r = await apiFetch('/api/ops-tasks', { method: 'POST', body: toOpsTaskPayload(t) });
    return { ok: r.ok, status: r.status, row: r.ok && r.data.row ? fromOpsTaskRow(r.data.row) : null };
  }
  // `patch` is local-shaped (camelCase) partial fields — only the keys
  // actually present are sent, same "absent fields are left untouched"
  // contract api/ops-tasks.js's PUT implements server-side.
  async function opsTaskUpdate(id, patch) {
    const body = {};
    if ('title' in patch) body.title = patch.title;
    if ('description' in patch) body.description = patch.description;
    if ('priority' in patch) body.priority = patch.priority;
    if ('assignedShift' in patch) body.assigned_shift = patch.assignedShift;
    if ('locationId' in patch) body.location_id = patch.locationId;
    if ('status' in patch) body.status = patch.status;
    const r = await apiFetch(`/api/ops-tasks?id=${encodeURIComponent(id)}`, { method: 'PUT', body });
    return { ok: r.ok, status: r.status, row: r.ok && r.data.row ? fromOpsTaskRow(r.data.row) : null };
  }
  async function opsTaskDelete(id) {
    return apiFetch(`/api/ops-tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  window.SidekickBackend = {
    isEnabled, register, login, registerLine, session, logout, migrateUpload,
    billingCheckout, billingPortal,
    lineChannelStatus, lineChannelConnect, lineChannelDisconnect,
    bookingSlotsList, bookingSlotCreate, bookingSlotDelete,
    bookingRequestsList, bookingRequestResolve,
    orderRequestsList, orderRequestResolve,
    teamCheckout, teamInvite, teamJoin, teamMembersList, teamMemberRemove,
    mirrorClientSave, mirrorClientDelete,
    mirrorJobSave: jobsMirror.mirrorSave, mirrorJobDelete: jobsMirror.mirrorDelete,
    mirrorServiceSave: servicesMirror.mirrorSave, mirrorServiceDelete: servicesMirror.mirrorDelete,
    mirrorInvoiceSave: invoicesMirror.mirrorSave, mirrorInvoiceDelete: invoicesMirror.mirrorDelete,
    invoiceFetchByCuid,
    mirrorDocumentSave: documentsMirror.mirrorSave, mirrorDocumentDelete: documentsMirror.mirrorDelete,
    mirrorBookingSave: bookingsMirror.mirrorSave, mirrorBookingDelete: bookingsMirror.mirrorDelete,
    mirrorFollowupSave: followupsMirror.mirrorSave,
    mirrorPortfolioSave: portfolioMirror.mirrorSave, mirrorPortfolioDelete: portfolioMirror.mirrorDelete,
    mirrorResearchSave: researchMirror.mirrorSave, mirrorResearchDelete: researchMirror.mirrorDelete,
    mirrorPackageSave: packagesMirror.mirrorSave,
    mirrorProgressLogSave: progressLogsMirror.mirrorSave, mirrorProgressLogDelete: progressLogsMirror.mirrorDelete,
    mirrorSettingSave, pullAll,
    opsTasksList, opsTaskCreate, opsTaskUpdate, opsTaskDelete,
  };
})();
