-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('buy_x_pay_y', 'buy_x_get_discount', 'bundle_deal');

-- CreateEnum
CREATE TYPE "PromotionDiscountKind" AS ENUM ('percent', 'fixed_amount');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "buyQuantity" INTEGER,
    "payQuantity" INTEGER,
    "minQuantity" INTEGER,
    "discountKind" "PromotionDiscountKind",
    "discountValue" DECIMAL(10,2),
    "bundlePrice" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionVariant" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "requiredQuantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PromotionVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionGroup" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "subGroupId" TEXT NOT NULL,

    CONSTRAINT "PromotionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_tenantId_isActive_idx" ON "Promotion"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "PromotionVariant_promotionId_idx" ON "PromotionVariant"("promotionId");

-- CreateIndex
CREATE INDEX "PromotionVariant_variantId_idx" ON "PromotionVariant"("variantId");

-- CreateIndex
CREATE INDEX "PromotionGroup_promotionId_idx" ON "PromotionGroup"("promotionId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVariant" ADD CONSTRAINT "PromotionVariant_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVariant" ADD CONSTRAINT "PromotionVariant_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionGroup" ADD CONSTRAINT "PromotionGroup_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionGroup" ADD CONSTRAINT "PromotionGroup_subGroupId_fkey" FOREIGN KEY ("subGroupId") REFERENCES "ItemSubGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
