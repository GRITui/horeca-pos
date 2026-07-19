# @grit/database

Centralized shared database package for Grit BizSuite. One Neon Postgres
database, one schema, consumed by every app (grit-pos, grit-inventory,
grit-taskboard, grit-reports). This package owns:

- **SQL migrations** (`migrations/`) — the source of truth for the schema.
- **Prisma 7 schema** (`prisma/schema.prisma`) — a typed mirror of the SQL,
  for apps that use Prisma Client.
- **Neon outbox store** (`src/outbox.ts`) — the `OutboxStore` implementation
  backing the `@grit/shared-events` event bus.
- **Demo seed data** (`seed/seed.sql`).

Like all Grit packages, it ships TypeScript source directly (no build step);
Next.js apps consume it via `transpilePackages: ["@grit/database"]`.

## Schema overview

| Table | Purpose |
| --- | --- |
| `organizations` | Tenant root. `tier` ∈ `LITE` \| `GROWTH` \| `SCALE`. |
| `organization_addons` | Addon marketplace flags, e.g. `custom_reporting`. PK `(organization_id, addon)`. |
| `users` | Grit Passport identity. `role` ∈ `owner` \| `manager` \| `staff`; email unique per org. |
| `locations` | `type` ∈ `retail` \| `warehouse` \| `service_hub` \| `kitchen`. |
| `products` | Org-scoped catalog; globally unique `sku`, `attributes` jsonb, optional `supplier_id`. |
| `product_variants` | Child SKUs for matrix variants (Size/Color/Style); price = parent `base_price` + `price_delta`. |
| `suppliers` | Named on Taskboard restock cards via `products.supplier_id`. |
| `transactions` / `transaction_items` | POS sales. `external_ref` is a unique nullable idempotency key for offline-sync. |
| `inventory_stocks` | Available quantity per `(location, product)` (unique pair) + `reorder_threshold`. |
| `stock_lots` | FIFO cost layers: drain `quantity_remaining` oldest-first by `received_at`. |
| `stock_transfers` / `stock_transfer_items` | Inter-location transfers. `status` ∈ `draft` \| `in_transit` \| `received` \| `cancelled`. |
| `tasks` | Taskboard cards. `status` ∈ `todo` \| `in_progress` \| `review` \| `done`; `priority` ∈ `low` \| `normal` \| `high`; `source_event_id` unique nullable for idempotent event-driven card creation. |
| `event_outbox` | Durable outbox for `@grit/shared-events`; partial index on undelivered rows. |

Status-like columns are `varchar` + SQL CHECK constraints (not PG enums), so
adding values later is a plain migration.

## Migrations

Migrations are hand-written SQL, applied **in order**, and idempotent
(`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` guards — re-running is a no-op):

1. `migrations/0001_core.sql` — base platform schema from the spec.
2. `migrations/0002_platform_extensions.sql` — tiers/addons, users, variants,
   FIFO lots, transfers, task/transaction extensions, event outbox, suppliers.

Apply with psql or the Neon SQL editor:

```sh
psql "$DATABASE_URL" -f migrations/0001_core.sql
psql "$DATABASE_URL" -f migrations/0002_platform_extensions.sql
```

The ordered file list is exported as `MIGRATION_FILES` for scripted runners:

```ts
import { MIGRATION_FILES, SEED_FILES } from "@grit/database";
// paths are relative to the package root:
const root = path.dirname(require.resolve("@grit/database/package.json"));
const files = MIGRATION_FILES.map((f) => path.join(root, f));
```

**Do not** use `prisma migrate dev` here — the SQL files are the source of
truth; `prisma/schema.prisma` is kept in sync by hand.

## Prisma client

`prisma/schema.prisma` mirrors the SQL exactly (snake_case tables via
`@@map`/`@map`, Prisma 7 `prisma-client` generator, output committed to
`src/generated/client`). Generate/validate from this package:

```sh
npx prisma generate   # writes src/generated/client
npx prisma validate
```

Then in an app:

```ts
import { PrismaClient } from "@grit/database/client";
```

Apps that already have their own Prisma setup can instead point their
`prisma.config.ts` at this package's schema.

## Event outbox store

`createNeonOutboxStore(sqlUrl)` implements the `OutboxStore` interface from
`@grit/shared-events` on top of the `event_outbox` table, using the
`@neondatabase/serverless` HTTP driver (works in serverless and edge runtimes):

```ts
import { createNeonOutboxStore } from "@grit/database";
import { GritEventBus, buildEvent } from "@grit/shared-events";

const bus = new GritEventBus({
  store: createNeonOutboxStore(process.env.DATABASE_URL!),
});

await bus.publish(buildEvent("transaction.completed", orgId, data));
// From a cron route, to retry failed deliveries:
await bus.drainOutbox();
```

- `save()` upserts idempotently on `event_id` (`ON CONFLICT DO NOTHING`).
- `markDelivered()` stamps `delivered_at`.
- `listUndelivered()` returns oldest-first undelivered envelopes, served by
  the partial index `event_outbox_undelivered_idx`.

## Seed data

`seed/seed.sql` (dev/demo only, idempotent — fixed UUIDs + `ON CONFLICT DO
NOTHING`): a SCALE-tier org with the `custom_reporting` addon, retail +
warehouse locations, one user per role (`owner@gritdemo.test`,
`manager@gritdemo.test`, `staff@gritdemo.test`), a supplier, two products
with matrix variants, per-location `inventory_stocks`, and multi-cost
`stock_lots` to exercise FIFO.

```sh
psql "$DATABASE_URL" -f seed/seed.sql
```

The seeded `password_hash` values are **placeholder strings** shaped like
bcrypt output — replace them with real bcrypt hashes before logging in with
those accounts.

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `createNeonOutboxStore` callers, `prisma.config.ts`, migration/seed commands | Neon Postgres connection string. The outbox store takes it as an explicit argument; Prisma CLI reads it via `prisma.config.ts` (no dotenv — export it in the shell/CI). |

## Package layout

```
migrations/0001_core.sql                 base schema (spec-verbatim + guards)
migrations/0002_platform_extensions.sql  platform extensions
prisma/schema.prisma                     Prisma 7 mirror of the SQL
prisma.config.ts                         Prisma CLI config (DATABASE_URL from env)
seed/seed.sql                            idempotent demo data
src/index.ts                             MIGRATION_FILES, SEED_FILES, re-exports
src/outbox.ts                            createNeonOutboxStore()
src/generated/client                     Prisma client output (after generate)
```
