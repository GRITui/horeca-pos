# Grit Inventory (formerly Invento)

Order-fulfillment, inventory, and delivery ops tool — now the inventory app
of the **Grit BizSuite** (multi-location stock, transfer orders, FIFO
costing, POS event ingestion). Milestone 1 (MVP) shipped an admin-only
internal console — staff enter and fulfill orders, manage stock, and track
manual deliveries; the Grit pivot (below) executed the documented Milestone 2
multi-store plan on top of it. No public storefront or checkout.

See `docs/ecommerce-stack-handoff.md` for the full architecture spec this
build implements (stack decision, milestone scope, and the Milestone 2
build-to-sell bundle design the schema is already stubbed for).

## Stack

Next.js (App Router) + TypeScript + React + Prisma ORM + Neon serverless
Postgres + Tailwind CSS, deployed as a single app on Vercel, with hand-rolled
JWT auth (`jose` + `bcryptjs`).

## Getting started

1. Create a [Neon](https://neon.tech) Postgres database (or point at any
   Postgres instance for local development — see "Local development without
   Neon" below).
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `AUTH_SECRET`
   (generate with `openssl rand -base64 32`), and `CRON_SECRET`.
3. Install dependencies and apply the schema:

   ```bash
   npm install
   npx prisma migrate deploy   # apply existing migrations
   npm run db:seed             # creates a demo tenant, store, and admin user
   npm run dev
   ```

4. Sign in at `http://localhost:3001/login` with the seeded admin
   (`admin@demo.invento` / `changeme123` by default — override with
   `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` env vars before seeding).

## Local development without Neon

The app's runtime client (`src/lib/db.ts`) uses the Neon serverless driver
adapter, matching the production target. If you want to develop against a
local Postgres instead, the simplest path is running one via Docker or your
package manager and swapping the adapter in `src/lib/db.ts` for
`@prisma/adapter-pg` (already a devDependency, used by the ad-hoc scripts in
`scripts/` for exactly this reason) — just don't commit that swap.

## Background jobs

`vercel.json` configures three Vercel Cron jobs, each hitting an API route
guarded by `CRON_SECRET` (checked as `Authorization: Bearer $CRON_SECRET`):

- `/api/cron/restock-alert` — daily; logs variants at/under their reorder
  threshold.
- `/api/cron/forecast-recompute` — nightly; naive moving-average forecast
  per variant, writes `ForecastSnapshot` rows with a suggested reorder qty.
- `/api/cron/dead-stock-scan` — nightly; flags in-stock variants with no
  sales in the trailing window as `DeadStockFlag` rows.

All three schedules are once/day, so they work on Vercel's Hobby plan as-is.
On a Pro plan or above you can tighten `restock-alert` to run more often
(e.g. hourly) if that cadence is useful.

## Ad-hoc test scripts

Consistent with team convention, this repo uses ad-hoc check-scripts rather
than a test framework. Each connects directly to a real Postgres database
(via `DATABASE_URL`) and exercises the actual business logic in `src/lib/`:

```bash
DATABASE_URL=<a-throwaway-or-local-postgres-url> npm run test:all
```

Or run them individually:

- `npm run test:smoke` — end-to-end order lifecycle: product/variant
  creation → order entry → payment → fulfillment (atomic stock decrement) →
  delivery creation → delivery status updates.
- `npm run test:concurrency` — fires concurrent decrement transactions at a
  single variant and asserts the row-locking in `lib/inventory.ts` never
  oversells or lets stock go negative.
- `npm run test:tenant-isolation` — creates two tenants with colliding SKUs
  and order numbers, asserts every cross-tenant lookup returns nothing.
- `npm run test:background-jobs` — exercises the restock-alert,
  forecast-recompute, and dead-stock-scan logic against seeded data.

These scripts create and clean up their own throwaway tenants, so they're
safe to run repeatedly against a shared dev database.

## Project structure

- `prisma/schema.prisma` — full Milestone 1 schema, plus `Bundle` /
  `BundleComponent` stubbed (unused) for Milestone 2's build-to-sell bundles.
- `src/lib/` — business logic: `inventory.ts` (row-locked stock movements),
  `orders.ts` (order status state machine + fulfillment), `deliveries.ts`
  (delivery status state machine), `auth.ts` / `session.ts` (JWT auth),
  `forecast.ts` / `deadstock.ts` / `restock.ts` (cron job logic).
- `src/app/admin/` — the staff-facing console (products, orders, deliveries,
  reports).
- `src/app/api/` — route handlers; `src/proxy.ts` (Next.js's middleware
  convention) gates everything under `/admin` and `/api` (except
  `/api/auth/login` and `/api/cron/*`) behind a valid session.

## What's deliberately out of scope for M1

Per the handoff: no public storefront/checkout, no third-party courier
integration, no dedicated forecasting/ML service. See the handoff's "Open
Questions" section for what would need answering before scoping those.

---

## Grit BizSuite pivot

This app is `apps/grit-inventory` in the Grit BizSuite monorepo. The pivot
executed the app's own documented M2 multi-store plan (handoff §4.1) and
wired the app into the suite's shared packages. All schema changes are
additive — migration
`prisma/migrations/20260718100000_grit_inventory_pivot/migration.sql`
(includes a data backfill of one `StoreStock` row per variant from the M1
`Variant.quantityOnHand` aggregate, targeting each tenant's default store).

### Multi-location stock

- **`StoreStock`** (`tenantId, storeId, variantId, quantityOnHand,
  reorderThreshold`, unique on the triple) is the authoritative per-store
  quantity. `Variant.quantityOnHand` is kept as a **maintained aggregate**
  (sum of stores, updated in the same transaction) so all existing screens
  and reports keep working.
- `applyStockMovement` (`src/lib/inventory.ts`) gained a `storeId` parameter
  (defaults to the tenant's default store), locks the `StoreStock` row (the
  variant row lock is still taken first, preserving the M1 serialization
  guarantees), and maintains the aggregate. `allowNegative` supports POS
  sale ingestion (the sale already happened; the ledger records it).
- **`Store`** gained `type` (`retail` | `warehouse` | `service_hub` |
  `kitchen`, default `retail`) and tenants may hold multiple stores. Admin
  UI: `/admin/stores` (create/rename; the default store cannot be deleted).
- Products list (`/admin/products`) gets a per-store filter for entitled
  (SCALE) tenants.

### Transfer orders

- **`StockTransfer`** (`draft → in_transit → received`, cancellable from
  draft/in_transit) + **`StockTransferItem`**. Dispatch decrements the source
  store (`transfer_out` movements, FIFO-drained; the per-unit FIFO cost is
  captured on each item), receipt increments the destination (`transfer_in`,
  creating lots at the carried cost), in-transit cancellation restores the
  source. New `StockMovementReason` values: `transfer_out`, `transfer_in`
  (plus `pos_sale`).
- API: `POST /api/transfers` (create draft), `GET /api/transfers`,
  `POST /api/transfers/[id]/transition`. Admin UI: `/admin/transfers`.
- Reaching `received` publishes `inventory.transfer_completed`.
- The product detail page (`/admin/products/[id]`) now shows a read-only
  stock-movement ledger (last 50 `StockMovement` rows across the product's
  variants, with reason/store/delta/when) below the Variants table.

### FIFO costing

- **`StockLot`** cost layers: every positive movement (restock, positive
  manual adjustment, `transfer_in`, `return`) creates a lot (`unitCost`
  input optional; defaults to the new `Variant.unitCost`, else 0).
- Consumption (`pos_sale`, `order_fulfillment`, `transfer_out`, negative
  adjustments) drains lots oldest-first inside the same transaction
  (`src/lib/fifo.ts: consumeFifo`), writing **`StockLotConsumption`** audit
  rows (`movementId, lotId, quantity, unitCost`; `lotId` null = fallback).
  Missing lots never block: the shortfall is costed at `Variant.unitCost`
  and logged.
- `GET /api/reports/cogs?from&to[&format=csv]` — FIFO COGS per variant from
  the drained-lot records (JSON default, CSV export). `transfer_out`
  consumption is excluded (moved, not sold).

### Events (in/out) — @grit/shared-events

- **Inbound**: `POST /api/events/grit` verifies the HMAC webhook
  (`GRIT_EVENT_WEBHOOK_SECRET`), validates with `parseGritEvent`, dedupes on
  `event_id` via the new **`ProcessedEvent`** table, and on
  `transaction.completed` decrements stock per item (reason `pos_sale`,
  FIFO drain, negative allowed). Unknown SKUs are skipped and listed in the
  200 response's `warnings`. The route is excluded from the session gate in
  `src/proxy.ts` (HMAC is its authentication).
  - **Tenancy mapping**: the envelope's `organization_id` is resolved by
    **equality with `Tenant.id`** — the platform organization id and this
    app's tenant id are the same identifier. `location_id` is matched
    against `Store.id`, falling back to the tenant's default store.
- **Outbound**: after each webhook decrement, if the store's stock is at or
  below its `reorderThreshold`, `inventory.threshold_breached` is published
  via `GritEventBus` + `createNeonOutboxStore` (`@grit/database`), with
  `supplier_name` from the new `Product.supplierName` when set.
  `inventory.transfer_completed` is published on transfer receipt.
- **Outbox + drain**: publishes are durably recorded in a local
  `event_outbox` table (mirrors `@grit/database`; **divergence:**
  `organization_id` is `TEXT` here because this app's tenant ids are cuids,
  not uuids). `GET /api/cron/events-drain` (CRON_SECRET-guarded, scheduled
  in `vercel.json`) re-delivers failures via `drainOutbox()`. Outbox errors
  are logged and never block the business operation.
- Everything degrades gracefully: with no `GRIT_EVENT_WEBHOOK_SECRET` /
  `GRIT_SUBSCRIBERS_*` / `DATABASE_URL`, event features are simply inert.

### Passport gates — @grit/passport

- `Tenant` gained additive `tier` (default `GROWTH`) and `addons` columns.
  Note: this app's `Tenant.tier` defaults to `GROWTH`, a deliberate
  divergence from the platform-canonical `LITE` default in `@grit/database`
  — existing invento tenants keep inventory access.
  `src/lib/passport.ts` bridges the existing JWT session to the shared
  `GritSession` (`tenantId → organizationId`, `storeId → locationId`,
  `OWNER → owner`, `ADMIN → manager`, `STAFF → staff`).
- Feature gates (`hasFeatureAccess` / `assertFeature`):
  - `inventory.multi_location` — stores admin page, store filter UI, and any
    operation on (or listing of) a non-default store. GROWTH tenants are
    gated from reading multiple location tables: the store filter is hidden
    and APIs return 403 (`FEATURE_NOT_ENTITLED`) for non-default stores.
  - `inventory.transfers` — transfers page + APIs.
  - `inventory.fifo_costing` — the COGS report.
- The admin layout renders the suite `AppSwitcher` (`@grit/shared-ui`) from
  `buildAppNav(session)`.

### Naming vs. the platform schema (@grit/database)

This app keeps its own Prisma schema (Pascal-case tables, cuid ids) and does
not point at `packages/database`. Equivalents mirror the platform contract's
semantics: `StoreStock` ≈ `inventory_stocks`, `StockLot` ≈ `stock_lots`,
`StockTransfer(-Item)` ≈ `stock_transfers(_items)`, `Store.type` ≈
`locations.type`, `Tenant.tier/addons` ≈ `organizations.tier` /
`organization_addons`. Divergences: ids are cuids (not uuids), lots/stocks
are keyed per **variant** (the platform keys per product), transfer items
carry a `unitCost` for FIFO cost carry-over, `Product.supplierName` is a
denormalized name rather than a `suppliers` FK, and the local `event_outbox`
stores `organization_id` as `TEXT`.

### Barcode scanning

`src/lib/useBarcodeScanner.ts` — client hook intercepting keyboard-wedge
scanners (rapid keystrokes terminated by Enter; configurable min length and
inter-key interval; human-speed typing is never captured). Wired into
`/admin/products`: scanning a known variant SKU jumps to its product;
an unknown SKU opens a quick "assign to variant" dialog
(`PATCH /api/variants/[id]` now accepts `sku`). Lookup endpoint:
`GET /api/variants/lookup?sku=...`.

### Warehouse operations schema (picking, packing, locations, labels, groups)

Additive schema in `prisma/migrations/20260718165651_grit_wms_epic/` lays the
foundation for a warehouse-ops epic layered on top of everything above:

- **`ItemGroup` / `ItemSubGroup`** — two-level product categorization.
  `Product.subGroupId` is nullable; existing products stay uncategorized
  until assigned.
- **`VariantLocation`** — planogram slot(s) per `(store, variant)`: a
  free-form `code` (e.g. `"A1-03-02"`), optional `zone`, and an `isPrimary`
  flag. Not DB-uniqueness-enforced (Prisma has no partial unique index) —
  app code treats the first `isPrimary=true` row as canonical.
- **`PickTask` / `PickTaskItem`** and **`PackTask` / `PackTaskItem`** —
  scanner-driven fulfillment sub-steps, **explicitly opt-in per order**: the
  existing `pending → paid → fulfilling → fulfilled` state machine in
  `lib/orders.ts` is completely unchanged. An order that never gets a
  `PickTask` created for it behaves exactly as before this addition; one
  that does gets a pick list (scan each line to fulfill `quantityRequired`),
  then a pack task (a second scan pass, catches mis-picks), then a
  `ParcelLabel` can be generated.
- **`ParcelLabel`** — an internal packing-slip-style label with a
  self-generated `trackingRef` printed as a barcode. No real carrier
  integration (no FedEx/UPS API) — MVP scope is an HTML label sized for
  label printers.

Schema only in this commit; the API routes, admin UI, and picking/packing
screens are tracked separately (see the sections each module adds below as
they land).

#### Item groups / sub-groups module

`/admin/groups` (SCALE, gated on `inventory.multi_location` — the existing
feature key, no new key was added): lists the tenant's `ItemGroup`s, each
expandable to its `ItemSubGroup`s. Both levels support create, inline
rename, and reorder (up/down, swaps `sortOrder` with the adjacent sibling
transactionally). Deletes are guarded: a group refuses (409) while it still
has sub-groups; a sub-group refuses (409) while any product still references
it via `Product.subGroupId`.

Product↔group assignment happens **only** from the sub-group side — each
sub-group has a "Products in this group" panel to search the tenant's
products (debounced, name-contains) and assign (`subGroupId` set) or remove
(`subGroupId` cleared) them. The product admin pages themselves are
untouched.

New endpoints (all under the `inventory.multi_location` gate; mutations
additionally require the ADMIN role):

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/item-groups` | List groups (with sub-groups + product counts) / create |
| `PATCH/DELETE /api/item-groups/[id]` | Rename and/or reorder / delete (409 if it has sub-groups) |
| `POST /api/item-groups/[id]/sub-groups` | Create a sub-group under a group |
| `PATCH/DELETE /api/item-sub-groups/[id]` | Rename and/or reorder / delete (409 if products are assigned) |
| `GET/POST/DELETE /api/item-sub-groups/[id]/products` | List assigned products / assign `{productId}` / unassign `{productId}` |

`GET /api/products` also gained an optional `?q=` search-by-name param
(case-insensitive `contains`, capped at 25 results), used by the assign
panel above; omitting it keeps the original unfiltered behavior.

#### Item location / planogram module

`/admin/locations` (SCALE, gated on `inventory.multi_location`): a store
selector (tab links, same pattern as the Products page's store filter) above
a table of that store's `VariantLocation` rows — SKU, product/variant name,
code, zone, and an `isPrimary` badge. Assignment happens **from this page**:
an "Assign a location" form searches the tenant's variants by SKU/name/product
name (client-side substring match) and adds a row for the picked variant; the
product admin pages themselves are untouched. Rows support inline edit and
delete.

The existing keyboard-wedge barcode scanner (`useBarcodeScanner`) is wired in:
scanning a known SKU (looked up via `GET /api/variants/lookup`) filters the
table down to that variant's locations at the selected store and pre-fills it
in the assign form; scanning an unknown SKU shows a dismissible "No such SKU"
banner instead of opening an assign-variant dialog (this page is about
locations, not SKU creation — contrast with the Products page's barcode
listener).

`isPrimary=true` is app-level-exclusive per `(storeId, variantId)` — not
DB-enforced (see the schema note above). `POST /api/variant-locations` and
`PATCH /api/variant-locations/[id]` both flip any other primary row for the
same `(storeId, variantId)` to `isPrimary=false` in the same transaction
before writing the new/edited row.

New endpoints (all under the `inventory.multi_location` gate; mutations
additionally require the ADMIN role):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/variant-locations?storeId=&variantId=&sku=` | List locations, filterable by store, variant id, or exact SKU |
| `POST /api/variant-locations` | Create a location (`{storeId, variantId, code, zone?, notes?, isPrimary?}`, defaults `isPrimary: true`) |
| `PATCH/DELETE /api/variant-locations/[id]` | Edit (code/zone/notes/isPrimary) or remove a location |

#### Picking / packing / parcel label module

The scanner-driven order-fulfillment-ops workflow (SCALE, gated on
`inventory.multi_location`): layered on top of the existing
`pending → paid → fulfilling → fulfilled` order state machine
(`src/lib/orders.ts`, unchanged) as an **explicitly opt-in** sub-flow. An
order that never gets a `PickTask` created for it behaves exactly as
before — the gate below only engages once a `PackTask` exists.

On `/admin/orders/[id]`, while an order is `fulfilling`, a "Fulfillment"
card walks staff through three steps, each gated on the previous one
completing:

1. **Pick** — "Start picking" creates a `PickTask` snapshotting each line's
   variant, required quantity, and (if assigned) the variant's primary
   `VariantLocation.code` at that store, so a later planogram edit doesn't
   retroactively change what the picker was shown. A checklist (SKU,
   product, location, `picked / required`) plus a scan box — wired to the
   real `useBarcodeScanner` keyboard-wedge listener, with a fallback text
   input + button for testing without hardware — let staff scan each unit;
   the task auto-completes once every item's `quantityPicked` meets its
   `quantityRequired`.
2. **Pack** — once picking is complete, "Start packing" creates a `PackTask`
   copied from the completed `PickTask`'s items (a second scan pass that
   re-verifies contents before sealing), with the same checklist/scan-box UI
   and the same auto-complete rule (`quantityPacked`).
3. **Label** — once packing is complete, "Generate label" creates a
   `ParcelLabel` (`trackingRef` self-generated as `PKG-<10 chars>`,
   `toName`/`toAddress` from the order's customer fields, `itemCount` summed
   from the order's lines) and a "Print label" link opens
   `/admin/orders/[id]/label/[labelId]` — a print-friendly view (`@media
   print` sized ~4x6) with the tracking ref as large text, a self-drawn
   div/SVG-style bar pattern (no real carrier integration or scannable
   barcode — this is an internal MVP label), destination, item count, and
   order number, plus a "Mark as printed" button.

None of this moves stock — the order's lines were already decremented at
the `fulfilling` transition (`applyStockMovement`, unchanged); picking and
packing only track the physical gather/verify/seal steps.

**The one change to the transition route**: `POST
/api/orders/[id]/transition` with `{to: "fulfilled"}` now checks whether the
order has a `PackTask`; if one exists and isn't `status: "complete"`, the
transition is refused with 409 instead of proceeding. An order with no
`PackTask` at all transitions exactly as before (fully backward compatible).
`transitionOrder`'s core state machine (`lib/orders.ts`) itself is
untouched — the check lives in the route handler.

Unlike the groups/locations/promotions modules above, these mutation
endpoints do **not** additionally require the ADMIN role — picking, packing,
and labeling are order-fulfillment-floor actions any signed-in staff member
performs mid-order, the same permissiveness as the pre-existing `POST
/api/orders/[id]/transition` and `/payments` routes. All are still gated on
the `inventory.multi_location` feature (SCALE).

| Endpoint | Purpose |
| --- | --- |
| `POST /api/orders/[id]/pick-task` | Create the pick task (409 if one exists, or order isn't `fulfilling`) |
| `GET /api/pick-tasks/[id]` | Fetch a pick task with its items |
| `POST /api/pick-tasks/[id]/scan` | Record one scanned unit (`{sku}`); auto-completes the task |
| `POST /api/orders/[id]/pack-task` | Create the pack task from a completed pick task (409 if pick task isn't complete, or a pack task exists) |
| `GET /api/pack-tasks/[id]` | Fetch a pack task with its items |
| `POST /api/pack-tasks/[id]/scan` | Record one scanned unit (`{sku}`); auto-completes the task |
| `POST /api/orders/[id]/parcel-label` | Generate a label (409 unless the pack task is complete) |
| `GET/PATCH /api/parcel-labels/[id]` | Fetch a label / mark it printed (`printedAt`, idempotent) |

#### Promotion admin module

`/admin/promotions` (SCALE, gated on `inventory.multi_location` — the
existing feature key, no new key added): lists the tenant's `Promotion`
rows (name, a type badge, and a human-readable summary — e.g. "Buy 3 pay
for 2", "Buy 5+ get 10% off", "Bundle: $49.99 for 3 items") with
create/edit/activate-deactivate/delete. One shared form handles all three
`PromotionType`s with type-specific fields:

- `buy_x_pay_y` — `buyQuantity` / `payQuantity` (`payQuantity` must be ≤
  `buyQuantity`), scoped by variants and/or item sub-groups.
- `buy_x_get_discount` — `minQuantity`, `discountKind`
  (`percent` ≤ 100 | `fixed_amount`), `discountValue`, same variant/sub-group
  scope picker.
- `bundle_deal` — `bundlePrice` plus an explicit multi-select of member
  variants, each with its own `requiredQuantity`. Per the schema design this
  type never uses `PromotionGroup` (sub-group) scoping — bundle membership is
  always explicit `PromotionVariant` rows.

The scope/bundle-member variant picker is a client-side SKU/name/product-name
substring search over the tenant's active variants (same pattern as the
Locations admin's assign form); the sub-group picker is a checkbox list of
the tenant's `ItemSubGroup`s. Edit submits the full desired state (a
"replace", not a partial patch) — the same schema as create, including
`isActive`, which is how deactivate works from the same endpoint.

**Publishing to Grit POS**: every create, edit, activate/deactivate, and
delete resolves the rule's `items: [{sku, required_quantity}]` (explicit
`scopeVariants` plus `scopeGroups` expanded to every product's variants
currently in that sub-group; explicit variant entries win on overlap) and
publishes `promotion.updated` via the same `getEventBus()` /
`EventOutbox` this app already uses for `inventory.*` events (see
`src/lib/promotions.ts`, `src/lib/events.ts`). Deactivating a promotion
(`isActive: false`) publishes `deleted: true` in the event just like a hard
delete does — from POS's cache-consumer perspective both mean "stop applying
this rule". Publish failures are logged and never block the CRUD request
(same `publishEventSafe` guarantee as the rest of the app's outbound
events).

New endpoints (all under the `inventory.multi_location` gate; mutations
additionally require the ADMIN role):

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/promotions` | List the tenant's promotions (with scope) / create |
| `GET/PATCH/DELETE /api/promotions/[id]` | Fetch one (for the edit form) / full-replace update / delete |

### New/changed environment variables

| Env var | Purpose |
| --- | --- |
| `GRIT_EVENT_WEBHOOK_SECRET` | Shared HMAC secret for inbound/outbound suite webhooks (unset → event features inert) |
| `GRIT_SUBSCRIBERS_INVENTORY_THRESHOLD_BREACHED` | Comma-separated subscriber URLs (e.g. taskboard webhook) |
| `GRIT_SUBSCRIBERS_INVENTORY_TRANSFER_COMPLETED` | Comma-separated subscriber URLs (e.g. reports webhook) |
| `GRIT_POS_URL` / `GRIT_INVENTORY_URL` / `GRIT_TASKBOARD_URL` / `GRIT_REPORTS_URL` | App-switcher base URLs (localhost defaults) |
| `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET` | Unchanged from M1 |

### New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/stores`, `PATCH/DELETE /api/stores/[id]` | Store management (SCALE) |
| `GET/POST /api/transfers`, `POST /api/transfers/[id]/transition` | Transfer orders (SCALE) |
| `GET/POST /api/variant-locations`, `PATCH/DELETE /api/variant-locations/[id]` | Planogram locations (SCALE) |
| `POST /api/orders/[id]/pick-task`, `POST /api/orders/[id]/pack-task`, `POST /api/orders/[id]/parcel-label`, `.../scan`, `GET/PATCH /api/parcel-labels/[id]` | Picking/packing/label workflow (SCALE — see "Picking / packing / parcel label module" above) |
| `GET /api/reports/cogs?from&to[&format=csv]` | FIFO COGS report (SCALE) |
| `GET /api/variants/lookup?sku=` | Barcode SKU lookup |
| `POST /api/events/grit` | Inbound HMAC event webhook (public route, HMAC-authed) |
| `GET /api/cron/events-drain` | Outbox redelivery (CRON_SECRET) |

### Build note

The app builds with the **webpack** bundler (`next build --webpack`; see
`package.json` scripts): the `@grit/*` packages ship TypeScript source using
ESM-style `./file.js` relative imports, which are mapped to the `.ts`
sources via `resolve.extensionAlias` in `next.config.ts` — Turbopack has no
equivalent setting yet. `npm run test:pivot`
(`scripts/grit-pivot-test.ts`) covers the multi-store/FIFO/transfer core
against a real Postgres.
