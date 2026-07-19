import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Naive threshold check — no third-party notification channel is wired up
 * for M1 (see handoff Section 6 open questions), so this surfaces alerts via
 * function logs and leaves them queryable through the same low-stock query
 * the admin dashboard already uses.
 */
export async function checkRestockAlerts(db: PrismaClient): Promise<{ alertCount: number }> {
  // Check per-store stock against its own threshold — Variant.quantityOnHand
  // is only the tenant-wide aggregate across stores, so a critically low
  // store can hide behind a healthy one elsewhere and never alert.
  const storeStocks = await db.storeStock.findMany({
    where: { variant: { isActive: true } },
    include: { variant: { include: { product: true } }, store: true },
  });
  const belowThreshold = storeStocks.filter((s) => s.quantityOnHand <= s.reorderThreshold);

  for (const stock of belowThreshold) {
    console.log(
      `[restock-alert] tenant=${stock.tenantId} store=${stock.store.name} sku=${stock.variant.sku} product="${stock.variant.product.name}" onHand=${stock.quantityOnHand} threshold=${stock.reorderThreshold}`
    );
  }

  return { alertCount: belowThreshold.length };
}
