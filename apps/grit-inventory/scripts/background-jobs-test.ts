import "dotenv/config";
import { testDb as db, cleanupTenant } from "./db-test-client";
import { checkRestockAlerts } from "@/lib/restock";
import { recomputeForecastSnapshots } from "@/lib/forecast";
import { scanDeadStock } from "@/lib/deadstock";

/**
 * Exercises the three Vercel Cron jobs' underlying logic (lib/restock.ts,
 * lib/forecast.ts, lib/deadstock.ts) against real data: a variant below its
 * reorder threshold, a variant with recent sales history, and a variant with
 * no sales in the dead-stock window.
 *
 * Run with: DATABASE_URL=<local-or-throwaway-db> npx tsx scripts/background-jobs-test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const run = `jobs-${Date.now()}`;
  const tenant = await db.tenant.create({ data: { name: `Jobs Test ${run}`, slug: run } });
  const store = await db.store.create({ data: { tenantId: tenant.id, name: "Main Store" } });
  const product = await db.product.create({ data: { tenantId: tenant.id, name: "Cron Test Product" } });

  await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `LOW-${run}`,
      name: "Low stock",
      price: 5,
      quantityOnHand: 1,
      reorderThreshold: 10,
    },
  });

  const activeVariant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `ACTIVE-${run}`,
      name: "Recently sold",
      price: 5,
      quantityOnHand: 20,
      reorderThreshold: 0,
    },
  });
  // Simulate 3 days of sales inside the forecast window (2/day).
  await db.stockMovement.createMany({
    data: [0, 1, 2].map((daysAgo) => ({
      tenantId: tenant.id,
      storeId: store.id,
      variantId: activeVariant.id,
      delta: -2,
      reason: "order_fulfillment",
      createdAt: new Date(Date.now() - daysAgo * DAY_MS),
    })),
  });

  const deadVariant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `DEAD-${run}`,
      name: "Never sold",
      price: 5,
      quantityOnHand: 8,
      reorderThreshold: 0,
      createdAt: new Date(Date.now() - 90 * DAY_MS),
    },
  });
  console.log("✓ seeded low-stock, recently-sold, and dead-stock variants");

  const { alertCount } = await checkRestockAlerts(db);
  assert(alertCount >= 1, "restock-alert should flag at least the low-stock variant");
  console.log(`✓ restock-alert flagged ${alertCount} variant(s) at/under threshold`);

  const { written } = await recomputeForecastSnapshots(db);
  assert(written >= 1, "forecast-recompute should write at least one snapshot");
  const snapshot = await db.forecastSnapshot.findFirst({ where: { variantId: activeVariant.id } });
  assert(snapshot !== null, "expected a ForecastSnapshot for the recently-sold variant");
  assert(Number(snapshot!.forecastQty) > 0, "forecastQty should be positive given recent sales");
  console.log(`✓ forecast-recompute wrote ${written} snapshot(s); recently-sold variant got forecastQty=${snapshot!.forecastQty}`);

  const { flagged } = await scanDeadStock(db);
  assert(flagged >= 1, "dead-stock-scan should flag at least the never-sold, 90-day-old variant");
  const flag = await db.deadStockFlag.findFirst({ where: { variantId: deadVariant.id } });
  assert(flag !== null, "expected a DeadStockFlag for the dead-stock variant");
  assert(flag!.reason === "Never sold", `expected reason "Never sold", got "${flag!.reason}"`);
  console.log(`✓ dead-stock-scan flagged ${flagged} variant(s), including the never-sold one`);

  const noDoubleFlag = await scanDeadStock(db);
  assert(noDoubleFlag.flagged === 0, "re-running dead-stock-scan should not re-flag an already-unresolved variant");
  console.log("✓ re-running dead-stock-scan does not duplicate an already-unresolved flag");

  await cleanupTenant(tenant.id);
  console.log("\nBackground jobs test passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
