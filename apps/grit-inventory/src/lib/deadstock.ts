import type { PrismaClient } from "@/generated/prisma/client";

const DEAD_STOCK_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Flags in-stock variants with no order_fulfillment movement in the trailing window. */
export async function scanDeadStock(db: PrismaClient, now: Date = new Date()): Promise<{ flagged: number }> {
  const cutoff = new Date(now.getTime() - DEAD_STOCK_DAYS * DAY_MS);

  const variants = await db.variant.findMany({
    where: { isActive: true, quantityOnHand: { gt: 0 } },
  });

  let flagged = 0;
  for (const variant of variants) {
    const lastSale = await db.stockMovement.findFirst({
      where: { variantId: variant.id, reason: "order_fulfillment" },
      orderBy: { createdAt: "desc" },
    });
    const referenceDate = lastSale?.createdAt ?? variant.createdAt;
    if (referenceDate > cutoff) continue;

    const existingFlag = await db.deadStockFlag.findFirst({
      where: { variantId: variant.id, resolvedAt: null },
    });
    if (existingFlag) continue;

    const daysSinceLastSale = Math.floor((now.getTime() - referenceDate.getTime()) / DAY_MS);
    await db.deadStockFlag.create({
      data: {
        tenantId: variant.tenantId,
        variantId: variant.id,
        reason: lastSale ? `No sales in ${DEAD_STOCK_DAYS} days` : "Never sold",
        daysSinceLastSale,
        quantityOnHand: variant.quantityOnHand,
      },
    });
    flagged++;
  }

  return { flagged };
}
