import type { PrismaClient } from "@/generated/prisma/client";

const WINDOW_DAYS = 28;
const LEAD_TIME_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Seasonal-naive / moving-average forecast — the "naive heuristic" M1 scope
 * calls for (handoff Section 2). Sums units sold per variant over the
 * trailing window, projects a weekly forecast, and suggests a reorder qty
 * against the configured lead time. Writes one ForecastSnapshot per variant
 * that sold anything in the window.
 */
export async function recomputeForecastSnapshots(db: PrismaClient, now: Date = new Date()): Promise<{ written: number }> {
  const periodEnd = now;
  const periodStart = new Date(periodEnd.getTime() - WINDOW_DAYS * DAY_MS);
  // Round to the start of the day so that re-running the job for the same
  // calendar day (cron retry, redeploy, manual re-trigger) is idempotent
  // instead of piling up near-duplicate rows a few seconds apart.
  const periodStartDay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));

  const sold = await db.stockMovement.groupBy({
    by: ["tenantId", "variantId"],
    where: { reason: "order_fulfillment", createdAt: { gte: periodStart, lte: periodEnd } },
    _sum: { delta: true },
  });

  const variants = await db.variant.findMany({
    where: { id: { in: sold.map((row) => row.variantId) } },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  let written = 0;
  for (const row of sold) {
    const variant = variantById.get(row.variantId);
    if (!variant) continue;

    const soldQty = Math.abs(row._sum.delta ?? 0);
    const dailyAverage = soldQty / WINDOW_DAYS;
    const forecastQty = dailyAverage * 7;
    const suggestedReorderQty = Math.max(0, Math.ceil(dailyAverage * LEAD_TIME_DAYS) - variant.quantityOnHand);

    // Idempotency: a snapshot already exists for this variant/day (cron
    // retry, redeploy, or manual re-trigger) — overwrite it instead of
    // creating another row, mirroring the existing-record check in
    // scanDeadStock().
    const existing = await db.forecastSnapshot.findFirst({
      where: { tenantId: row.tenantId, variantId: row.variantId, periodStart: periodStartDay },
    });
    if (existing) {
      await db.forecastSnapshot.update({
        where: { id: existing.id },
        data: { periodEnd, method: "moving_average", forecastQty, suggestedReorderQty },
      });
    } else {
      await db.forecastSnapshot.create({
        data: {
          tenantId: row.tenantId,
          variantId: row.variantId,
          periodStart: periodStartDay,
          periodEnd,
          method: "moving_average",
          forecastQty,
          suggestedReorderQty,
        },
      });
    }
    written++;
  }

  return { written };
}
