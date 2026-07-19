-- Grit promotion cache: adds `promotion_rules`, the local read-only cache of
-- Grit Inventory Promotion rules kept in sync by the inbound `promotion.updated`
-- webhook (app/api/events/grit/route.ts). Purely additive — a single new
-- table with an FK to the existing `tenants` table. No existing table is
-- altered, so this is safe to apply to a database already carrying live
-- Tenant/Order/Payment data.
--
-- Generated via `npx prisma migrate diff --from-config-datasource
-- prisma.config.ts --to-schema prisma/schema.prisma --script` against the
-- live dev database (not `prisma migrate dev`'s shadow-db diff) — this repo's
-- pre-existing 20260718120000_grit_pos_pivot migration only contains
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements against tables that
-- were originally created via `db push` before any migrations directory
-- existed, so a from-empty shadow database can never replay that migration
-- (it errors with "relation \"tenants\" does not exist"). This predates and
-- is unrelated to this change; hand-placing the diff-verified SQL here and
-- applying with `prisma migrate deploy` (which never touches a shadow
-- database) works around it, matching how the previous migration was
-- authored for the same reason (see README.md's Migrations section).

-- CreateTable
CREATE TABLE "promotion_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "buyQuantity" INTEGER,
    "payQuantity" INTEGER,
    "minQuantity" INTEGER,
    "discountKind" TEXT,
    "discountValue" DECIMAL(10,2),
    "bundlePrice" DECIMAL(12,2),
    "items" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_rules_tenantId_idx" ON "promotion_rules"("tenantId");

-- CreateIndex
CREATE INDEX "promotion_rules_tenantId_isActive_idx" ON "promotion_rules"("tenantId", "isActive");

-- AddForeignKey
ALTER TABLE "promotion_rules" ADD CONSTRAINT "promotion_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
