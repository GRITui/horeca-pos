# Grit POS (formerly horeca-pos)

Next.js 16 + Prisma 7 + Neon front-of-house checkout app for the Grit
BizSuite: staff register, QR dine-in, pickup links, end-of-day
reconciliation. The core is channel-agnostic checkout; everything
hospitality- or retail-specific is an optional **plugin trait**.

Runs fully standalone: its own deploy, its own `DATABASE_URL`, its own staff
login. All Grit BizSuite integration (events, suite nav, tier gates) degrades
to inert when the related env vars are unset.

## Grit POS pivot — what was added

### 1. Plugin traits (`lib/traits.ts`)

Hospitality capability is no longer hard-wired. Traits are persisted per
tenant in `Tenant.enabledTraits` (`string[]`, additive column):

| Trait | Gates | Default |
| --- | --- | --- |
| `hospitality.tables` | Table records, staff table picker, `/t/[tableToken]` page, `/api/public/table/**` | **ON** |
| `hospitality.pickup_links` | `/pickup/[tenantSlug]` pages, `/api/pickup/**` | **ON** |
| `retail.variant_matrix` | Attribute selectors in the register's ProductPicker | off |

Existing tenants keep today's behavior unchanged (hospitality defaults ON at
both the schema and migration level). Gating happens at entry points only:

- QR dine-in: `lib/tokenLink.ts#verifyTableToken` is the single choke point —
  with the trait off, every table token resolves to the same generic 404.
- Pickup: `app/api/pickup/_resolve.ts#resolveTenantBySlug` likewise (both
  pickup pages now resolve through it).
- Staff dashboard: the table picker section renders only when
  `hospitality.tables` is on.

### 2. Retail variant matrix (`lib/variantMatrix.ts`)

Additive `Variant` columns: `sku` (nullable, unique per tenant via a
denormalized nullable `Variant.tenantId` + `@@unique([tenantId, sku])`) and
`attributes Json` (e.g. `{"size":"L","color":"black"}`).

`lib/variantMatrix.ts` (isomorphic, dependency-free) provides:
`attributeAxesFromVariants`, `expandAttributeAxes` / `expandChildSkus`
(cartesian child-SKU generation, e.g. `TSHIRT` → `TSHIRT-L-BLACK`), and
`resolveVariantSelection` (attribute selection → concrete child variant).

The catalog API (`/api/catalog`) now serializes `sku` + `attributes` per
variant, and the POS ProductPicker renders per-axis attribute buttons (and
resolves to the child SKU) when the `retail.variant_matrix` trait is on and a
product's variants carry attributes. Divergence from `@grit/database`: the
canonical `product_variants.sku` is globally unique; here it is unique per
tenant (nullable), since this app is multi-tenant on one database.

### 3. Offline-first register

- `components/pos/offlineQueue.ts` — hand-rolled IndexedDB queue (no deps)
  storing ops with a client-generated `externalRef` (uuid).
- `components/pos/api.ts` — `tenderOrder` captures **network-failed** tenders
  into the queue (HTTP errors are never queued); `submitQuickSale` sends a
  full offline **quick sale** (create order + lines + cash tender as one op)
  through the sync endpoint online or queued offline.
- `POST /api/orders/offline-sync` — idempotent replay target; applies ops in
  order and dedupes on `Payment.externalRef` (additive unique nullable
  column, mirroring `transactions.external_ref` in `@grit/database` —
  camelCase per this app's column convention). Per-op results:
  `applied | duplicate | rejected`.
- `components/pos/OfflineStatusChip.tsx` — header chip showing online state +
  queue depth; owns the sync loop (`online` event + 20s interval).
- Offline UI is mounted only when the org is entitled to `pos.offline_mode`
  (`@grit/passport` `hasFeatureAccess`).

Orders completed via offline sync publish `transaction.completed` with
`offline_synced: true`.

### 4. Events out (`lib/events.ts`, `lib/velocity.ts`)

Publishing uses `@grit/shared-events` `GritEventBus` with
`@grit/database`'s `createNeonOutboxStore` on this app's own `DATABASE_URL`
(the `event_outbox` table ships in this app's migration, mirroring the
canonical DDL). All publishing is **fire-and-forget after the DB transaction
commits** (`next/server` `after()`) — checkout never blocks or fails on
event delivery.

- `transaction.completed` — emitted when an order becomes fully paid/closed
  from the staff tender route, the Stripe webhook confirm, and offline sync.
  Notes: `location_id` is the **tenant id** (no Location model yet);
  `tax_amount` is always `0` (no tax model yet); item `sku` is the variant's
  child SKU or the fallback `PRD-<productId>`. Known limitation: fallback SKUs
  are POS-internal ids, so grit-inventory will skip them as unknown unless the
  same SKU exists there — cross-app stock decrement requires the catalogs to
  share real child SKUs (assign variant SKUs in both apps).
- `pos.velocity_surge` — after each completed transaction,
  `lib/velocity.ts` counts the tenant's closed orders in the trailing
  `GRIT_SURGE_WINDOW_MIN` (default 10) minutes; at ≥ `GRIT_SURGE_THRESHOLD`
  (default 25) it publishes once per window (deduped against the outbox).
- Envelope `organization_id` is the **raw tenant id** (a cuid, unchanged).
  The platform outbox stores `organization_id` as opaque text with no FK to
  `organizations`, and grit-inventory maps it back to `Tenant.id` by
  equality — no id translation happens on the way out.
- `GET/POST /api/cron/events-drain` — bearer `CRON_SECRET` (grit-inventory's
  pattern); calls `bus.drainOutbox()` to re-deliver failed webhooks.

### 5. Passport bridge + commercial gates (`lib/passportBridge.ts`)

Additive `Tenant` columns `tier` (default `'LITE'`) and `addons`
(`string[]`) mirror `organizations.tier` / `organization_addons`.

This app **keeps its own login** (`horeca_session`, `lib/auth.ts`). The SSO
bridge step derives a `GritSession` from it per request (`tenantId` →
`organizationId`, same role vocabulary, tier/addons read from the Tenant
row) — it does not mint or verify the shared `grit_passport` cookie yet;
that swap is the future full-SSO step. The derived session feeds:

- `@grit/shared-ui` `AppSwitcher` in the staff layout, showing **only**
  `appsForSession` results (LITE ⇒ POS alone — no layout panel links into
  inventory networks the plan excludes).
- `hasFeatureAccess` gates: the offline-mode UI mounts only with
  `pos.offline_mode`.

## Environment variables

Required to run: `DATABASE_URL`, `SESSION_SECRET`. Stripe (pickup checkout):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Optional Grit BizSuite integration (all inert when unset — see
`.env.example`): `GRIT_EVENT_WEBHOOK_SECRET`,
`GRIT_SUBSCRIBERS_TRANSACTION_COMPLETED`,
`GRIT_SUBSCRIBERS_POS_VELOCITY_SURGE`, `CRON_SECRET`,
`GRIT_SURGE_WINDOW_MIN`, `GRIT_SURGE_THRESHOLD`, `GRIT_POS_URL`,
`GRIT_INVENTORY_URL`, `GRIT_TASKBOARD_URL`, `GRIT_REPORTS_URL`,
`GRIT_SERVICE_TOKEN`.
(`GRIT_SESSION_SECRET` becomes relevant only at the full-SSO step; the
passport bridge doesn't sign tokens.)

`GRIT_SERVICE_TOKEN` gates the service-to-service bearer auth path on
`GET /api/reports/revenue` (below) — grit-reports' margin aggregator calls
that endpoint with `Authorization: Bearer $GRIT_SERVICE_TOKEN` since it has
no staff session of its own. Leaving it unset disables that path entirely
(any bearer header gets a flat 401); it never falls back to treating an
unset/mismatched token as authenticated.

## New/changed endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/orders/offline-sync` | Idempotent offline-queue replay (tender + quick_sale ops), auth required |
| `GET/POST /api/cron/events-drain` | Outbox retry drain, `Authorization: Bearer $CRON_SECRET` |
| `GET /api/reports/revenue?from&to` | Revenue for `grit-reports`' margin aggregator (`{from,to,revenue,tax:0,count,daily:[{date,revenue,count}]}`); staff session **or** `Authorization: Bearer $GRIT_SERVICE_TOKEN` + `?organization_id=<tenant id>` |
| `GET /api/catalog` | Now includes `sku` + `attributes` per variant |
| `/t/**`, `/api/public/table/**` | 404 when `hospitality.tables` trait is off |
| `/pickup/**`, `/api/pickup/**` | 404 when `hospitality.pickup_links` trait is off |

## Migrations

`prisma/migrations/20260718120000_grit_pos_pivot/migration.sql` (this app
previously shipped schema-only; the migrations dir is new). All statements
are additive and idempotent. `npx prisma validate` passes without a
database; `npx prisma migrate deploy` requires a reachable `DATABASE_URL`
(or apply the SQL with psql). The migration also creates `event_outbox`,
mirroring `packages/database/migrations/0002_platform_extensions.sql`.

## Build notes

- Builds with **webpack** (`next build --webpack`): the `@grit/*` packages
  ship TypeScript source with ESM `./module.js` relative imports, which
  webpack resolves via `experimental.extensionAlias` (see `next.config.ts`).
  Turbopack (the Next 16 default) has no equivalent and cannot resolve those
  imports; revisit if the shared packages move to extensionless imports.
- `lib/prisma.ts` constructs the Prisma client lazily (first access), so
  `next build` succeeds with no env vars set.
