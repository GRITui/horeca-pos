# grit-reports

Static, no-build report constructor (vanilla JS + bundled SheetJS/Chart.js),
served as static output on Vercel with a thin serverless `api/` layer for
cross-app aggregation. Part of the Grit BizSuite monorepo — see the root
[`AGENTS.md`](../../AGENTS.md) for the cross-app conventions this app
follows (event contracts only, never direct cross-database queries).

## What's here

```
excel-group-analyze/     the static app (served as the Vercel output directory)
  index.html / app.js      Excel Group & Analyze — upload a spreadsheet, group,
                            calculate, filter/sort, cross-tab, chart, export .xlsx
  grit-dashboard.html/js   Grit BizSuite dashboard — cross-app margin & labor
                            KPIs, backed by the api/ aggregator below
  xlsx.full.min.js         bundled SheetJS (no npm dependency)
  chart.umd.js             bundled Chart.js (no npm dependency)
api/                      Vercel serverless functions (Node.js runtime, plain
                            ESM, no build step — see "Aggregator API" below)
lib/                      helpers shared by the api/ functions
tests/                    pure-node test suite (`node tests/test-aggregate.mjs`)
```

## Excel Group & Analyze

Client-only spreadsheet tool: upload an `.xlsx`/`.xls`/`.csv`, group rows by
one or more key columns, sum/count/avg/min/max data columns, build SUMIF/
COUNTIF-style conditional metrics, write formula-based calculated columns,
label groups with rule-based categories, join a second lookup file, filter/
sort/top-N the result, pivot into a cross-tab, chart it, and download the
result as a formatted `.xlsx`. Presets save to `localStorage` (export/import
as a file to move them between machines). See the in-app Help panel for the
formula syntax and details. No server involved — everything runs in the
browser against the bundled SheetJS/Chart.js.

## Grit BizSuite dashboard (`grit-dashboard.html`)

A second page, linked from the Excel Group & Analyze header, that calls the
aggregator API below and renders:

- KPI tiles: POS revenue, inventory COGS, gross margin (total + %),
  transaction count, average taskboard task-completion time, and a
  transactions-per-completed-task efficiency ratio.
- A daily revenue bar chart (Chart.js, from the margins endpoint's `daily`
  series).
- Per-upstream "not connected" chips (grit-pos / grit-inventory /
  grit-taskboard) driven by each response's `upstream` markers — so a
  not-yet-built or unreachable upstream endpoint reads as a chip, never a
  crash or a silently-zero dashboard.
- A locked state (padlock panel) when the aggregator returns 401 (not
  signed in) or 403 (missing the `custom_reporting` addon), with copy
  explaining what's needed.
- **Download CSV** — exports the loaded range's daily + summary metrics as a
  `date,metric,value` CSV that can be dropped straight into
  `index.html`'s Excel Group & Analyze (group by `metric`, sum `value`).

Auth: paste a Grit Passport bearer token into the field at the top of the
page, or leave it blank to rely on the `grit_passport` cookie already set by
another Grit BizSuite app in the same browser (cross-subdomain SSO — see
`@grit/passport`'s README for the cookie's `domain` attribute).

## Aggregator API (`api/`)

Cross-app data is pulled **over HTTP from each sibling app's own API** —
never a direct cross-database query (see root `AGENTS.md`). Every upstream
call funnels through `lib/upstreamFetch.js`, which degrades the same way
everywhere:

| Situation | `upstream.<app>` marker | Numbers |
| --- | --- | --- |
| Env var for the app's URL unset | `"unconfigured"` | zeroed |
| Upstream 404 (endpoint not built yet) or a network error/timeout | `"missing"` | zeroed |
| Upstream reachable but returns a non-2xx | `"error"` | zeroed |
| Upstream reachable and returns 2xx JSON | `"ok"` | populated |

No combination of these ever crashes the endpoint — the aggregator is
inert (all-zero, all-marker) when its env vars aren't configured, so this
app keeps working standalone.

### `GET /api/aggregate-margins?from&to`

POS revenue minus inventory FIFO COGS over `[from, to]` (dates default to
the last 30 days when omitted or unparsable).

- `GET {GRIT_POS_URL}/api/reports/revenue?from&to&organization_id=<session.organizationId>`
  — grit-pos's revenue report. **May not exist upstream yet**; a 404/network
  error just zeroes the revenue side (`upstream.pos = "missing"`).
- `GET {GRIT_INVENTORY_URL}/api/reports/cogs?from&to&format=json&organization_id=<session.organizationId>`
  — grit-inventory's FIFO COGS report (exists today: `apps/grit-inventory/src/app/
  api/reports/cogs/route.ts`). Response is `{ from, to, total_cogs, rows: [{
  sku, product, variant, units_consumed, fifo_cogs, avg_unit_cost,
  fallback_units }] }` — a **period total only**, no daily breakdown.
  `organization_id` is required on both calls: each upstream's
  service-token auth path scopes strictly off that query param (no session
  of its own); omitting it 401s and permanently zeroes that side of the
  aggregate.

Response:

```jsonc
{
  "from": "2026-06-18", "to": "2026-07-18",
  "revenue": { "total": 10000, "count": 42 },
  "cogs": { "total": 4000, "rows_count": 12 },
  "margin": { "total": 6000, "pct": 60 },
  "daily": [{ "date": "2026-07-01", "revenue": 5000, "cogs": null, "margin": null }],
  "daily_note": "Per-day COGS/margin are not computable: ...",
  "upstream": { "pos": "ok", "inventory": "ok" }
}
```

`daily[].cogs`/`margin` are always `null` — the inventory COGS endpoint has
no per-day breakdown to attach, so this endpoint doesn't fabricate one.

### `GET /api/aggregate-labor?from&to`

POS transaction volume ÷ taskboard checklist completion speed over
`[from, to]`.

- Reuses the revenue endpoint's `count` field for transaction volume (same
  `GRIT_POS_URL` call, same "may not exist yet" tolerance).
- `GET {GRIT_TASKBOARD_URL}/api/ops-tasks?status=done&since=<from>&organization_id=<session.organizationId>` —
  does not exist in `apps/grit-taskboard/api` as of this writing, so this codes
  against the documented shape: an array of task objects with
  `created_at`/`completed_at` ISO timestamps (matching the `task.completed`
  event's data shape in `packages/shared-events/src/contracts.ts`). 404/
  network error degrades to `upstream.taskboard = "missing"`.

Response:

```jsonc
{
  "from": "2026-06-18", "to": "2026-07-18",
  "transactions": { "count": 42 },
  "tasks": { "completed_count": 5, "avg_completion_hours": 3.2 },
  "efficiency": { "transactions_per_completed_task": 8.4, "avg_completion_hours": 3.2 },
  "upstream": { "pos": "ok", "taskboard": "ok" }
}
```

### Entitlement gate

Both endpoints require the Grit Passport session's org to have the
`custom_reporting` addon (see `packages/passport/src/entitlements.ts`
`ADDON_MATRIX.custom_reporting` — `minTier: "GROWTH"`, feature
`reports.custom_builder`). Auth is `Authorization: Bearer <jwt>` or the
`grit_passport` cookie.

- Missing/invalid/expired/tampered token → `401 { error, code: "UNAUTHORIZED" }`
- Valid session, addon missing (or tier below GROWTH) → `403 { error, code:
  "FEATURE_NOT_ENTITLED", feature: "reports.custom_builder" }`

`lib/passportVerify.js` is a hand-rolled HS256 JWT verifier (Node's
`node:crypto` `webcrypto` export — the same primitive
`@grit/shared-events/src/webhook.ts` uses for HMAC signing, applied to JWT
verification instead) mirroring `packages/passport/src/session.ts`
**exactly**: same cookie name (`grit_passport`), same secret resolution
(`GRIT_SESSION_SECRET`, falling back to `SESSION_SECRET`), same payload
shape, same `exp`/`nbf` validation. No `jose` dependency — this app adds no
npm dependencies at all. If `session.ts`'s session shape ever changes,
update this mirror to match (same discipline as
`apps/grit-taskboard/lib/gritEvents.js` mirroring `@grit/shared-events`).

## Environment variables

| Env var | Purpose | Required? |
| --- | --- | --- |
| `GRIT_SESSION_SECRET` | HS256 secret for Grit Passport JWT verification (falls back to `SESSION_SECRET`) | Yes, for the aggregator to authenticate anyone — unset means every request gets `401` |
| `SESSION_SECRET` | Legacy fallback for `GRIT_SESSION_SECRET` | No |
| `GRIT_POS_URL` | Base URL of grit-pos, for `/api/reports/revenue` | No — unset degrades to `upstream.pos = "unconfigured"`, zeroed revenue/transactions |
| `GRIT_INVENTORY_URL` | Base URL of grit-inventory, for `/api/reports/cogs` | No — unset degrades to `upstream.inventory = "unconfigured"`, zeroed COGS |
| `GRIT_TASKBOARD_URL` | Base URL of grit-taskboard, for `/api/ops-tasks` | No — unset degrades to `upstream.taskboard = "unconfigured"`, zeroed task stats |
| `GRIT_SERVICE_TOKEN` | Forwarded as `Authorization: Bearer <token>` on every upstream call | No — omitted header if unset |

None of these are read at module load time in a way that throws; every
missing var degrades a specific feature rather than breaking the app, so
`grit-reports` keeps deploying and running standalone with zero env vars
configured (Excel Group & Analyze needs none of them at all).

## Tests

```sh
cd apps/grit-reports
node tests/test-aggregate.mjs
```

Pure `node:test`, no install: mints its own HS256 JWTs with `node:crypto`
and asserts `lib/passportVerify.js` accepts a valid token and rejects a
tampered payload, an expired token, a wrong-secret signature, and malformed
input; asserts `hasCustomReportingAddon` requires both the addon and a
GROWTH+ tier; and exercises both aggregator endpoints end-to-end against a
stubbed `global.fetch`, covering the upstream-present, upstream-404/network-
error, and upstream-unconfigured paths, plus the 401/403 gate.

`node --check` passes on every `.js`/`.mjs` file in this app.

## Deploy

`vercel.json` sets `outputDirectory: "excel-group-analyze"` for the static
site; `api/` at the app root is auto-detected by Vercel as serverless
functions regardless of `outputDirectory` (same pattern as
`apps/grit-taskboard/vercel.json`). No build step, no npm dependencies.
