-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "discountStackingPolicy" TEXT NOT NULL DEFAULT 'NO_STACKING';

-- CreateTable
CREATE TABLE "PromotionExclusion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "excludedPromotionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionExclusion_tenantId_idx" ON "PromotionExclusion"("tenantId");

-- CreateIndex
CREATE INDEX "PromotionExclusion_excludedPromotionId_idx" ON "PromotionExclusion"("excludedPromotionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionExclusion_promotionId_excludedPromotionId_key" ON "PromotionExclusion"("promotionId", "excludedPromotionId");

-- AddForeignKey
ALTER TABLE "PromotionExclusion" ADD CONSTRAINT "PromotionExclusion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionExclusion" ADD CONSTRAINT "PromotionExclusion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionExclusion" ADD CONSTRAINT "PromotionExclusion_excludedPromotionId_fkey" FOREIGN KEY ("excludedPromotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
