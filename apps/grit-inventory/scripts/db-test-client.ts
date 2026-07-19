import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Standalone Prisma client for the ad-hoc scripts in this folder. Uses the
 * plain node-postgres adapter (works against any Postgres, including a local
 * instance) rather than the Neon adapter `src/lib/db.ts` uses in the app —
 * so these scripts can run against a disposable local database without
 * requiring a live Neon endpoint.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run scripts/ against a database");
}

export const testDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** No relation in the schema cascades from Tenant (deliberately — accidental
 * tenant deletion shouldn't silently wipe every child row in production), so
 * test scripts clean up in explicit dependency order instead. */
export async function cleanupTenant(tenantId: string) {
  const db = testDb;
  await db.deliveryStatusEvent.deleteMany({ where: { delivery: { tenantId } } });
  await db.delivery.deleteMany({ where: { tenantId } });
  await db.payment.deleteMany({ where: { order: { tenantId } } });
  // Grit pivot tables: consumption rows reference movements and lots, so they
  // go first; StoreStock/StockLot/transfers reference stores and variants.
  await db.stockLotConsumption.deleteMany({ where: { tenantId } });
  await db.stockLot.deleteMany({ where: { tenantId } });
  await db.storeStock.deleteMany({ where: { tenantId } });
  await db.stockTransferItem.deleteMany({ where: { transfer: { tenantId } } });
  await db.stockTransfer.deleteMany({ where: { tenantId } });
  await db.stockMovement.deleteMany({ where: { tenantId } });
  await db.orderLine.deleteMany({ where: { order: { tenantId } } });
  await db.order.deleteMany({ where: { tenantId } });
  await db.forecastSnapshot.deleteMany({ where: { tenantId } });
  await db.deadStockFlag.deleteMany({ where: { tenantId } });
  await db.bundleComponent.deleteMany({ where: { bundle: { tenantId } } });
  await db.bundle.deleteMany({ where: { tenantId } });
  await db.variant.deleteMany({ where: { tenantId } });
  await db.product.deleteMany({ where: { tenantId } });
  await db.user.deleteMany({ where: { tenantId } });
  await db.store.deleteMany({ where: { tenantId } });
  await db.tenant.delete({ where: { id: tenantId } });
}
