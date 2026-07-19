-- Grit POS pivot: plugin traits, retail variant matrix, offline-sync
-- idempotency, commercial tier/addons, and the cross-app event outbox.
--
-- NOTE: horeca-pos previously shipped schema-only (no migrations dir). This
-- migration is written to be safe against a database that already carries the
-- pre-pivot schema: every statement is additive and idempotent
-- (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), matching the convention used by
-- packages/database. Apply with `npx prisma migrate deploy` (requires a
-- reachable DATABASE_URL) or psql.

-- ---------------------------------------------------------------------------
-- Tenant: plugin traits + commercial tier/addons
-- ---------------------------------------------------------------------------

-- Hospitality traits default ON so existing tenants keep today's behavior
-- unchanged; "retail.variant_matrix" is opt-in (see lib/traits.ts).
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "enabledTraits" TEXT[] DEFAULT ARRAY['hospitality.tables', 'hospitality.pickup_links']::TEXT[];

-- Mirrors organizations.tier / organization_addons in @grit/database.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'LITE';

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "addons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ---------------------------------------------------------------------------
-- Variant: retail variant-matrix columns
-- ---------------------------------------------------------------------------

ALTER TABLE "variants"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

ALTER TABLE "variants"
  ADD COLUMN IF NOT EXISTS "sku" VARCHAR(100);

ALTER TABLE "variants"
  ADD COLUMN IF NOT EXISTS "attributes" JSONB;

-- sku unique per tenant when present (NULLs never collide). The canonical
-- platform schema (@grit/database product_variants.sku) is globally unique —
-- divergence documented in README.md.
CREATE UNIQUE INDEX IF NOT EXISTS "variants_tenantId_sku_key"
  ON "variants"("tenantId", "sku");

-- ---------------------------------------------------------------------------
-- Payment: offline-sync idempotency key
-- ---------------------------------------------------------------------------

-- Mirrors transactions.external_ref in @grit/database (camelCase column name
-- per this app's convention). Unique when present so a retried offline sync
-- can never double-book a payment.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "externalRef" VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS "payments_externalRef_key"
  ON "payments"("externalRef");

-- ---------------------------------------------------------------------------
-- Event outbox: durable record of published cross-app events
-- ---------------------------------------------------------------------------

-- Exact mirror of packages/database/migrations/0002_platform_extensions.sql
-- (event_outbox) so @grit/database's createNeonOutboxStore can run its raw
-- SQL against this app's own DATABASE_URL.
CREATE TABLE IF NOT EXISTS "event_outbox" (
  "event_id" VARCHAR(100) NOT NULL,
  "event_name" VARCHAR(100) NOT NULL,
  -- Opaque envelope org id (apps may use non-uuid tenant ids, e.g. cuids),
  -- so this is intentionally text with no FK to organizations.
  "organization_id" TEXT,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(6),

  CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX IF NOT EXISTS "event_outbox_created_at_idx"
  ON "event_outbox"("created_at");

-- Retry drain scans only undelivered rows, oldest first (matches the
-- canonical partial index; partial indexes are not expressible in the Prisma
-- schema, so this exists only here in SQL).
CREATE INDEX IF NOT EXISTS "event_outbox_undelivered_idx"
  ON "event_outbox"("created_at")
  WHERE "delivered_at" IS NULL;
