-- Grit BizSuite pivot: multi-location stock (StoreStock), transfer orders,
-- FIFO costing lots, event ingestion/outbox, tier/addon columns.
-- All changes are additive. Includes a data backfill: one StoreStock row per
-- (variant, tenant default store) seeded from Variant.quantityOnHand.

-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'transfer_out';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'transfer_in';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'pos_sale';

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('draft', 'in_transit', 'received', 'cancelled');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'GROWTH',
ADD COLUMN "addons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "type" VARCHAR(32) NOT NULL DEFAULT 'retail';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "supplierName" TEXT;

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN "unitCost" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "StoreStock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "reorderThreshold" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantityReceived" INTEGER NOT NULL,
    "quantityRemaining" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "StockLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLotConsumption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "lotId" TEXT,
    "variantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLotConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromStoreId" TEXT NOT NULL,
    "toStoreId" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2),

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable (mirrors @grit/database event_outbox; organization_id is TEXT
-- here because this app's tenant ids are cuids, not uuids)
CREATE TABLE "event_outbox" (
    "event_id" VARCHAR(100) NOT NULL,
    "event_name" VARCHAR(100) NOT NULL,
    "organization_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreStock_tenantId_storeId_variantId_key" ON "StoreStock"("tenantId", "storeId", "variantId");

-- CreateIndex
CREATE INDEX "StoreStock_tenantId_variantId_idx" ON "StoreStock"("tenantId", "variantId");

-- CreateIndex
CREATE INDEX "StoreStock_storeId_idx" ON "StoreStock"("storeId");

-- CreateIndex
CREATE INDEX "StockLot_tenantId_storeId_variantId_receivedAt_idx" ON "StockLot"("tenantId", "storeId", "variantId", "receivedAt");

-- CreateIndex
CREATE INDEX "StockLotConsumption_tenantId_variantId_createdAt_idx" ON "StockLotConsumption"("tenantId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "StockLotConsumption_movementId_idx" ON "StockLotConsumption"("movementId");

-- CreateIndex
CREATE INDEX "StockLotConsumption_lotId_idx" ON "StockLotConsumption"("lotId");

-- CreateIndex
CREATE INDEX "StockTransfer_tenantId_status_idx" ON "StockTransfer"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StockTransferItem_transferId_idx" ON "StockTransferItem"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_eventId_key" ON "ProcessedEvent"("eventId");

-- CreateIndex (retry drain scans only undelivered rows, oldest first —
-- mirrors event_outbox_undelivered_idx in @grit/database)
CREATE INDEX "event_outbox_undelivered_idx" ON "event_outbox"("created_at") WHERE "delivered_at" IS NULL;

-- AddForeignKey
ALTER TABLE "StoreStock" ADD CONSTRAINT "StoreStock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreStock" ADD CONSTRAINT "StoreStock_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreStock" ADD CONSTRAINT "StoreStock_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLotConsumption" ADD CONSTRAINT "StockLotConsumption_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLotConsumption" ADD CONSTRAINT "StockLotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromStoreId_fkey" FOREIGN KEY ("fromStoreId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toStoreId_fkey" FOREIGN KEY ("toStoreId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DataMigration: backfill one StoreStock row per (variant, tenant default
-- store) from the M1 Variant.quantityOnHand aggregate. DISTINCT ON picks a
-- single default store per tenant (M1 guarantees one store per tenant).
INSERT INTO "StoreStock" ("id", "tenantId", "storeId", "variantId", "quantityOnHand", "reorderThreshold", "createdAt", "updatedAt")
SELECT
    'ss_' || md5(v."id" || ':' || s."id"),
    v."tenantId",
    s."id",
    v."id",
    v."quantityOnHand",
    v."reorderThreshold",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Variant" v
JOIN (
    SELECT DISTINCT ON ("tenantId") "tenantId", "id"
    FROM "Store"
    WHERE "isDefault" = true
    ORDER BY "tenantId", "createdAt" ASC
) s ON s."tenantId" = v."tenantId"
ON CONFLICT ("tenantId", "storeId", "variantId") DO NOTHING;
