# Grit BizSuite

API-first monorepo merging four standalone SaaS products into one cohesive
platform for SMEs, per the *Grit BizSuite Ecosystem Monorepo* blueprint spec.
Each app still runs (and deploys) independently; integration happens only
through shared data contracts and HMAC-signed internal webhook events — never
through direct cross-app database queries.

```
grit-bizsuite/
├── apps/
│   ├── grit-pos/          # (formerly horeca-pos)          front-of-house checkout engine
│   ├── grit-inventory/    # (formerly invento)             multi-location stock tracking
│   ├── grit-taskboard/    # (formerly Sidekickz)           ops kanban & automation
│   └── grit-reports/      # (formerly Grit-Report-builder) cross-app report constructor
├── packages/
│   ├── database/          # @grit/database      canonical schema, migrations, event outbox store
│   ├── shared-events/     # @grit/shared-events event contracts, webhook signing, bus
│   ├── passport/          # @grit/passport      SSO session, RBAC, tier entitlements
│   └── shared-ui/         # @grit/shared-ui     GRITui React components
├── package.json           # npm workspaces
└── turbo.json
```

## Apps

| App | Stack | Pivot delivered |
| --- | --- | --- |
| **grit-pos** | Next.js 16 · Prisma 7 · Neon · Stripe | Hospitality features (QR tables, pickup links) abstracted into optional **plugin traits**; product **variant matrix** (child SKUs + attribute axes); **offline-first** IndexedDB tender/quick-sale queue with idempotent sync; emits `transaction.completed` and `pos.velocity_surge` |
| **grit-inventory** | Next.js 16 · Prisma 7 · Neon | **Multi-location** per-store stock (`StoreStock`) with internal **transfer orders**; **FIFO** cost lots + COGS report; **barcode** keyboard-wedge interception; consumes `transaction.completed` (auto-decrement), emits `inventory.threshold_breached` |
| **grit-taskboard** | No-build JS PWA · Vercel functions · Neon | **Ops kanban** (`todo / in_progress / review / done`) added to the PWA; webhook intake auto-creates *"Restock SKU: X from Supplier Y immediately"* and *"Open auxiliary billing terminal lines"* cards; emits `task.completed` |
| **grit-reports** | Static vanilla JS · Vercel functions | Excel Group & Analyze tool + **cross-app aggregator**: financial margins (POS revenue − inventory COGS) and labor efficiency (POS volume ÷ task completion speed), gated by the `custom_reporting` addon |

## Event flow

```
grit-pos ──transaction.completed──────────▶ grit-inventory ──inventory.threshold_breached──▶ grit-taskboard
   │                                             │                                               │
   └──pos.velocity_surge─────────────────────────┼───────────────────────────────────────────────┤
                                                 └──inventory.transfer_completed──▶ grit-reports ◀┴──task.completed
```

Transport: HMAC-signed internal webhooks (`x-grit-signature: v1=hex(hmac-sha256("<ts>.<body>"))`,
shared secret `GRIT_EVENT_WEBHOOK_SECRET`) with a durable Postgres outbox +
cron drain for retries. Contracts live in `packages/shared-events/src/contracts.ts`;
the no-build taskboard mirrors the wire format in `apps/grit-taskboard/lib/gritEvents.js`.
Subscribers are configured per event: `GRIT_SUBSCRIBERS_<EVENT_NAME>` (comma-separated URLs).

## Commercial tiers (Grit Passport)

| Tier | Apps mounted | Notes |
| --- | --- | --- |
| **LITE** | POS | Inventory-facing panels disabled |
| **GROWTH** | POS + Inventory | Single-location tracking only (multi-location tables gated) |
| **SCALE** | All four | Multi-location, transfers, FIFO costing, taskboard automation |
| Addon `custom_reporting` | — | Unlocks the grit-reports aggregation pipelines |

`hasFeatureAccess()` / `appsForSession()` in `@grit/passport` drive both UI
navigation (shared `AppSwitcher`) and API-side gates (`assertFeature`, 403).

## Development

```bash
npm install            # workspace install (root)
npm run build          # turbo build across apps
npm run typecheck      # turbo typecheck
```

Per-app: the two Next apps build with `npm run build` (pinned to webpack —
Turbopack cannot yet resolve the packages' `.js → .ts` ESM specifiers) and need
`DATABASE_URL` only at runtime, not build time. Inventory's full test battery:
`cd apps/grit-inventory && DATABASE_URL=<postgres> npm run test:all`. Taskboard
and reports have pure-node suites under `tests/`.

The canonical platform schema (blueprint Section 3, plus platform extensions)
is in `packages/database/migrations/` with a mirrored Prisma schema. Apps keep
their own historical schemas and adopt canonical naming additively; divergences
are documented in each app's README.

## Provenance

Merged from `GRITui/horeca-pos` (this repo's history), `GRITui/invento`,
`GRITui/Sidekickz`, and `GRITui/Grit-Report-builder` — each source repo carries
a `MONOREPO-MIGRATION.md` pointing here. Each app retains its own
`package.json` / lockfile / `vercel.json` so it can be deployed (or extracted)
standalone.
