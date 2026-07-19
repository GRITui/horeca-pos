# Grit Taskboard (apps/grit-taskboard)

No-build plain-JS PWA (`app/`) + Vercel serverless functions (`api/`) with a
Neon Postgres backend (`lib/db.js`, `@neondatabase/serverless`). Formerly
"Sidekick" — a freelancer/solo-operator admin app (clients, invoices, jobs,
bookings, follow-ups, research library). This pass ("the Grit Taskboard
pivot") layers an **operations kanban with cross-app event automation** on
top, without touching any existing freelancer feature.

See the monorepo root `AGENTS.md` for how this app fits into Grit BizSuite
and the cross-app event contract convention. This app is one of the apps
that never imports another app's TypeScript packages directly for the event
layer — `packages/shared-events`' wire format is hand-mirrored in
`lib/gritEvents.js` instead (see that file's header), because this app has
no build step and can't import TypeScript source.

## What's new: Ops board + event automation

### 1. Schema (`sql/schema-core.sql`, mirrored verbatim in `lib/schemaSql.js`)

- **`ops_tasks`** — kanban cards. `id` (text, primary key) is a **client- or
  server-mintable cuid**, unlike every other table in this file: it mirrors
  the platform `tasks` table's own primary key name 1:1
  (`packages/database/migrations/0001_core.sql` /
  `0002_platform_extensions.sql`), since a card can be born on either side —
  a person creating one in the Ops board UI (client-minted id), or
  `api/grit-events.js` minting one server-side from an inbound event.
  Columns: `user_cuid`, `location_id`, `title`, `description`, `status`
  (`todo`|`in_progress`|`review`|`done`), `priority`
  (`low`|`normal`|`high`), `triggered_by`
  (`system_inventory`|`system_pos`|`manual`), `assigned_shift`,
  `source_event_id` (unique, nullable — idempotency key for event-driven
  cards), `created_at`/`updated_at`, `completed_at`.
- **`grit_org_links`** — one taskboard account <-> one Grit BizSuite
  organization id (an opaque string; this app never validates it beyond
  "non-empty"). `user_cuid` is the primary key (strict 1:1); `organization_id`
  is separately unique. `api/grit-events.js`'s webhook handler reads this
  table to route an inbound event to the right account; an unmapped
  `organization_id` is a 202-and-skip, never an error.

Regenerate `lib/schemaSql.js` after any schema edit with the command in that
file's own header comment, then `node tests/test-schema-sync.mjs`.

### 2. Event intake (`lib/gritEvents.js`, `api/grit-events.js`)

`lib/gritEvents.js` is a plain-JS mirror of
`packages/shared-events/src/webhook.ts` + `src/contracts.ts`: HMAC-SHA256
sign/verify (`signGritWebhook`/`verifyGritWebhook`, `node:crypto`,
timing-safe compare, 5-minute timestamp tolerance) plus minimal envelope
validation (`parseGritEvent`). **Wire-format changes must be made in both
this file and the TypeScript original** — see `AGENTS.md`.

`api/grit-events.js` is the inbound webhook endpoint. Server-to-server only
(no browser CORS wiring, unlike every other `api/*.js` here):

| Signal | Response |
| --- | --- |
| Bad/missing/stale signature | `401` |
| Malformed JSON / envelope fails validation | `400` |
| Event this app doesn't consume (unknown, or e.g. `transaction.completed`) | `202` `{ignored:true}` |
| `organization_id` has no `grit_org_links` row | `202` `{skipped:true, reason:'unlinked_org'}` |
| `inventory.threshold_breached` | creates a card: *"Restock SKU: `<sku>` from `<supplier_name ?? 'preferred supplier'>` immediately"*, priority `high`, `triggered_by: 'system_inventory'`, description carries location/qty/threshold |
| `pos.velocity_surge` | creates a card: *"Open auxiliary billing terminal lines"*, priority `high`, `triggered_by: 'system_pos'`, description carries the surge window/threshold |

Both card-creating paths are idempotent on `source_event_id = event_id`
(`on conflict (source_event_id) do nothing`, replay returns the existing
card's id with `201`→`200`).

### 3. Org link + task CRUD + emit (`api/grit-org-link.js`, `api/ops-tasks.js`)

- **`api/grit-org-link.js`** — authed `GET`/`PUT`/`DELETE` of the calling
  account's `grit_org_links` row. `PUT` body: `{organization_id}`; `409` if
  that organization id is already linked to a different account.
- **`api/ops-tasks.js`** — authed CRUD for `ops_tasks`, same row-scoping
  rule as every resource endpoint here (`lib/auth.js` bearer session ->
  `lib/teams.js resolveDataOwner`, never a client-supplied owner field).
  - `GET /api/ops-tasks?status=<status>&since=<ISO timestamp>` — both
    optional filters. `status=done&since=<t>` filters on `completed_at >=
    t` (matching grit-reports' aggregate-labor.js's "completed since"
    semantics, so a later unrelated edit to an old done card can't pull it
    back into the window); every other `status`/`since` combination keeps
    filtering on `updated_at`.
  - `GET` also accepts a **service-token** auth path, for grit-reports'
    cross-app labor aggregator
    (`apps/grit-reports/api/aggregate-labor.js`) — it has no taskboard
    session of its own. Send `Authorization: Bearer $GRIT_SERVICE_TOKEN`
    plus a required `?organization_id=<id>`; the org is resolved to its
    owning account via `grit_org_links`. An unrecognized/unlinked
    `organization_id` is a normal `200` with `{rows: []}`, not an error —
    the org may just not have connected a taskboard account yet. While
    `GRIT_SERVICE_TOKEN` is unset, this path is fully disabled and every
    `GET` uses ordinary bearer-session auth, same as before it existed.
    Mirrors grit-pos's `app/api/reports/revenue/route.ts` bearer-token
    path. `POST`/`PUT`/`DELETE` never accept this token — writes stay
    session-only.
  - `POST /api/ops-tasks` — body `{id, title, description?, priority?,
    assigned_shift?, location_id?, status?}` (snake_case, matching every
    other resource endpoint's `select *` pass-through convention).
    `triggered_by` is always `'manual'` here — `system_inventory`/
    `system_pos` cards only ever come from `api/grit-events.js`.
  - `PUT /api/ops-tasks?id=<id>` — partial update; entering `status: 'done'`
    stamps `completed_at`, leaving `'done'` for any other status (the
    kanban's regress affordance) clears it.
  - `DELETE /api/ops-tasks?id=<id>`.
  - On a transition **into** `done`, if `GRIT_SUBSCRIBERS_TASK_COMPLETED` is
    set, fires a signed `task.completed` envelope
    (`packages/shared-events/src/contracts.ts` `TaskCompletedData`) to every
    configured subscriber URL — best-effort (failures are logged and
    swallowed, never fail or roll back the task write itself; skipped
    silently if the account has no `grit_org_links` row to attribute the
    event to, or if `GRIT_EVENT_WEBHOOK_SECRET` is unset).
  - Writes are rate-limited (`lib/rateLimit.js`, 60/min per IP) and gated by
    the same locked-account write-lock every other resource endpoint uses
    (`lib/entitlements.js canWrite`).

### 4. Ops board UI (`app/opsboard.js`, wired into `app/index.html`/`app/app.js`)

New screen (`#s-opsboard`, nav entry under More → More tools, next to
Follow-ups/Portfolio/Research) — four columns (To do / In progress / Review
/ Done). Cards show title, a priority badge (high priority visually
distinct via the shared `.chip-overdue` token), a `triggered_by` indicator
(📦 Inventory / 🧾 POS surge / blank for manual), and assigned shift.
Tapping **Advance ›** moves a card forward one column; **‹ Back** regresses
it (both ends disabled at the boundary columns). A **+ New task** button
opens the create form (title, priority, assigned shift), following the same
modal pattern `research.js`'s `buildFormModal` establishes.

**Data layer.** Local-first IndexedDB store `'opsTasks'` (`app/app.js`
`openDB()`, `DB_VER` 7→8): `keyPath: 'id'` with **no** `autoIncrement`,
unlike every other store in this app — `id` here *is* the stable cuid
identity on both the client and server (mirroring `ops_tasks.id` 1:1),
rather than pairing a local autoincrement id with a separate `cuid` field.
Registered in `BACKUP_STORES`/`IMPORT_ORDER` (included in
export/restore/guest-adoption), with one small special case in
`importDataset()`: an `opsTasks` row is restored via `put()` with its `id`
preserved verbatim rather than `add()`-with-remap, since (unlike every
other store) nothing else references an ops task by id, so there's no
cross-reference to remap and the id is globally stable already.

**Sync choice (documented per the task spec's either/or).** `opsboard.js`
reuses `window.SidekickBackend` (extended in `app/dataClient.js` with
`opsTasksList`/`opsTaskCreate`/`opsTaskUpdate`/`opsTaskDelete`) rather than
a second, parallel fetch/token implementation — `dataClient.js` already owns
every other endpoint's auth/error shape (bearer token from
`sidekick_backend_token`, `{ok, status, data}`), and `ops_tasks` fits that
shape with no bespoke wrinkle that would justify going around it. Sync is
**screen-scoped**, not part of the account-wide `pullAll()`/`BACKUP_STORES`
restore flow: `renderOpsBoard()` pulls fresh from the server every time the
screen opens (server wins on a same-`id` row — the pull always overwrites
the local copy), and every local create/status-change pushes back
best-effort (fire-and-forget, same `.catch(() => {})` posture every other
`mirrorXSave` call site in this app already uses).

### 5. Grit Passport SSO (`lib/passport.js`)

`lib/passport.js` is a plain-JS mirror of `@grit/passport`'s session
verification (`packages/passport/src/session.ts`) — same "hand-mirror
because this app has no build step" rationale as `lib/gritEvents.js`
mirroring `packages/shared-events`, and the same `node:crypto` `webcrypto`
technique `apps/grit-reports/lib/passportVerify.js` uses for its own JWT
verification (no `jose` dependency needed). Exports:

- `verifyPassportSession(req)` — resolves the `GritSession` from a Fetch API
  `Request`'s `Authorization: Bearer <jwt>` header or `grit_passport`
  cookie, or `null` if neither is present/valid.
- `hasFeature(session, feature)` — minimal tier gate; currently only
  recognizes `"taskboard.automation"` (mirrors
  `hasFeatureAccess(session, "taskboard.automation")` from
  `packages/passport/src/entitlements.ts` — SCALE tier only, per that
  package's Commercial Core Configurations Matrix).

**Deliberate divergence from the suite convention:** every other mirror
(including `packages/passport/README.md`'s own mirror snippet) resolves the
signing secret as `GRIT_SESSION_SECRET ?? SESSION_SECRET`. This app's
`SESSION_SECRET` already signs a completely unrelated bearer-token scheme —
this app's own 30-day user sessions (`lib/auth.js`) — so falling back to it
here would HMAC two different wire formats with the same key. `lib/passport.js`
reads `GRIT_SESSION_SECRET` **only**; see that file's header and
`.env.example` for the full rationale. While `GRIT_SESSION_SECRET` is unset,
`verifyPassportSession()` always returns `null` rather than silently reusing
`SESSION_SECRET`.

Not wired into any endpoint's auth yet (`api/grit-events.js` is
HMAC-authenticated and has no session to verify; `api/ops-tasks.js` keeps
its own `lib/auth.js` bearer scheme plus the `GRIT_SERVICE_TOKEN` service
path above) — exported ahead of use for a future "Continue with Grit
Passport" UI login path.

### 6. Tests

- `tests/test-grit-events.mjs` — sign/verify round-trip, tampered-body
  rejection, stale-timestamp rejection, `inventory.threshold_breached`
  creating a card idempotently against a fake sql, `pos.velocity_surge`
  card creation, unlinked-org `202`-skip, unknown-event `202`-ignore, bad
  signature `401`.
- `tests/test-ops-tasks.mjs` — `GET /api/ops-tasks`'s service-token auth
  path (valid token + linked org lists tasks, valid token + unlinked org ->
  `200`/empty list, wrong token -> falls through to session auth -> `401`,
  `GRIT_SERVICE_TOKEN` unset -> path disabled -> `401`/session fallback) and
  the `status=done&since=` `completed_at`-vs-`updated_at` filter window.
- `tests/test-schema-sync.mjs` — unchanged, now also guards the
  `ops_tasks`/`grit_org_links` addition staying byte-identical between
  `sql/schema-core.sql` and `lib/schemaSql.js`.

Run:

```sh
node tests/test-grit-events.mjs
node tests/test-ops-tasks.mjs
node tests/test-schema-sync.mjs
bash tests/run-all.sh   # full battery, including Playwright check-*.js suites
```

## New environment variables

See `.env.example` for the full annotated list; new for this pass:

| Env var | Purpose | While unset |
| --- | --- | --- |
| `GRIT_EVENT_WEBHOOK_SECRET` | Shared HMAC secret (same value across every Grit BizSuite app) signing/verifying the `packages/shared-events` wire format | `api/grit-events.js` answers `500`; `api/ops-tasks.js` silently skips emitting `task.completed` |
| `GRIT_SUBSCRIBERS_TASK_COMPLETED` | Comma-separated subscriber URLs for the outbound `task.completed` event | No card completion ever emits an event — the board itself still works fully |
| `GRIT_SERVICE_TOKEN` | Service-to-service bearer token for `GET /api/ops-tasks` (grit-reports' labor aggregator) | The service-token GET path is disabled; every `GET` uses ordinary bearer-session auth |
| `GRIT_SESSION_SECRET` | Grit Passport SSO signing secret (`lib/passport.js`), same value across every Grit BizSuite app — **not** the same secret as `SESSION_SECRET` | `lib/passport.js`'s `verifyPassportSession()` always returns `null` |

## New endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/grit-events` | HMAC signature (server-to-server) | Inbound `inventory.threshold_breached`/`pos.velocity_surge` webhook -> ops task |
| `GET/PUT/DELETE /api/grit-org-link` | Bearer session | This account's `grit_org_links` row |
| `GET/POST/PUT/DELETE /api/ops-tasks` | Bearer session (GET also accepts `GRIT_SERVICE_TOKEN` + `?organization_id=`) | Ops kanban CRUD |

## Everything else

Unchanged — see `project-changelog-handshake-gym.md` for the full history of
the freelancer-app build (clients/jobs/invoices/documents/bookings/
follow-ups/portfolio/research/team/billing/LINE integration) this pivot
builds alongside.
