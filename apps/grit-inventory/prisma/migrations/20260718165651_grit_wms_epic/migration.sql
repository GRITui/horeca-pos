-- CreateEnum
CREATE TYPE "PickTaskStatus" AS ENUM ('pending', 'in_progress', 'complete');

-- CreateEnum
CREATE TYPE "PackTaskStatus" AS ENUM ('pending', 'in_progress', 'complete');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "subGroupId" TEXT;

-- CreateTable
CREATE TABLE "ItemGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemSubGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemSubGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantLocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "zone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "storeId" TEXT,
    "status" "PickTaskStatus" NOT NULL DEFAULT 'pending',
    "assignedToId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickTaskItem" (
    "id" TEXT NOT NULL,
    "pickTaskId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationCode" TEXT,
    "quantityRequired" INTEGER NOT NULL,
    "quantityPicked" INTEGER NOT NULL DEFAULT 0,
    "scannedAt" TIMESTAMP(3),

    CONSTRAINT "PickTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "PackTaskStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackTaskItem" (
    "id" TEXT NOT NULL,
    "packTaskId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantityRequired" INTEGER NOT NULL,
    "quantityPacked" INTEGER NOT NULL DEFAULT 0,
    "scannedAt" TIMESTAMP(3),

    CONSTRAINT "PackTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParcelLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "trackingRef" TEXT NOT NULL,
    "toName" TEXT,
    "toAddress" TEXT,
    "itemCount" INTEGER NOT NULL,
    "weightKg" DECIMAL(8,3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "ParcelLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemGroup_tenantId_idx" ON "ItemGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemGroup_tenantId_name_key" ON "ItemGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ItemSubGroup_tenantId_idx" ON "ItemSubGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemSubGroup_groupId_name_key" ON "ItemSubGroup"("groupId", "name");

-- CreateIndex
CREATE INDEX "VariantLocation_tenantId_storeId_idx" ON "VariantLocation"("tenantId", "storeId");

-- CreateIndex
CREATE INDEX "VariantLocation_variantId_idx" ON "VariantLocation"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PickTask_orderId_key" ON "PickTask"("orderId");

-- CreateIndex
CREATE INDEX "PickTask_tenantId_status_idx" ON "PickTask"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PickTaskItem_pickTaskId_idx" ON "PickTaskItem"("pickTaskId");

-- CreateIndex
CREATE INDEX "PickTaskItem_orderLineId_idx" ON "PickTaskItem"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PackTask_orderId_key" ON "PackTask"("orderId");

-- CreateIndex
CREATE INDEX "PackTask_tenantId_status_idx" ON "PackTask"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PackTaskItem_packTaskId_idx" ON "PackTaskItem"("packTaskId");

-- CreateIndex
CREATE INDEX "PackTaskItem_orderLineId_idx" ON "PackTaskItem"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ParcelLabel_trackingRef_key" ON "ParcelLabel"("trackingRef");

-- CreateIndex
CREATE INDEX "ParcelLabel_tenantId_orderId_idx" ON "ParcelLabel"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "Product_subGroupId_idx" ON "Product"("subGroupId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_subGroupId_fkey" FOREIGN KEY ("subGroupId") REFERENCES "ItemSubGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSubGroup" ADD CONSTRAINT "ItemSubGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSubGroup" ADD CONSTRAINT "ItemSubGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ItemGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantLocation" ADD CONSTRAINT "VariantLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantLocation" ADD CONSTRAINT "VariantLocation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantLocation" ADD CONSTRAINT "VariantLocation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTaskItem" ADD CONSTRAINT "PickTaskItem_pickTaskId_fkey" FOREIGN KEY ("pickTaskId") REFERENCES "PickTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTaskItem" ADD CONSTRAINT "PickTaskItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackTask" ADD CONSTRAINT "PackTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackTask" ADD CONSTRAINT "PackTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackTaskItem" ADD CONSTRAINT "PackTaskItem_packTaskId_fkey" FOREIGN KEY ("packTaskId") REFERENCES "PackTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackTaskItem" ADD CONSTRAINT "PackTaskItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParcelLabel" ADD CONSTRAINT "ParcelLabel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParcelLabel" ADD CONSTRAINT "ParcelLabel_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParcelLabel" ADD CONSTRAINT "ParcelLabel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
