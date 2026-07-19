// Seeds the local grit_inventory database for the "trading company" demo
// persona: a distributor with two locations — a Warehouse (receives bulk
// restocks, NOT the default store) and a Showroom (isDefault — POS sales
// hit the default store per the current org-id-fallback convention, since
// grit-pos has no Location model yet). Two restock lots at different costs
// land at the Warehouse (a real multi-lot FIFO scenario); a stock transfer
// then moves units to the Showroom before any sale, so the demo exercises
// multi-location + transfers + FIFO cost carry-over, not just a decrement.
// Run: DATABASE_URL=... DEMO_ORG_ID=<pos tenant id> npx tsx dev/local-run/seed-trading-co-inventory.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { createRequire } from "node:module";
const requireFromApp = createRequire(new URL("../../apps/grit-inventory/package.json", import.meta.url));
const bcrypt = requireFromApp("bcryptjs") as typeof import("bcryptjs");
import { PrismaClient } from "../../apps/grit-inventory/src/generated/prisma/client";

const orgId = process.env.DEMO_ORG_ID;
if (!orgId) throw new Error("DEMO_ORG_ID (the POS trading-co tenant id) is required");

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const tenant = await db.tenant.upsert({
    where: { id: orgId },
    update: { tier: "SCALE", addons: ["custom_reporting"] },
    create: {
      id: orgId,
      name: "Grit Trading Co.",
      slug: "grit-trading",
      tier: "SCALE",
      addons: ["custom_reporting"],
    },
  });

  let showroom = await db.store.findFirst({ where: { tenantId: tenant.id, name: "Showroom" } });
  showroom ??= await db.store.create({
    data: { tenantId: tenant.id, name: "Showroom", isDefault: true, type: "retail" },
  });

  let warehouse = await db.store.findFirst({ where: { tenantId: tenant.id, name: "Central Warehouse" } });
  warehouse ??= await db.store.create({
    data: { tenantId: tenant.id, name: "Central Warehouse", isDefault: false, type: "warehouse" },
  });

  await db.user.upsert({
    where: { email: "admin@grit-trading.co" },
    update: {},
    create: {
      tenantId: tenant.id,
      storeId: showroom.id,
      email: "admin@grit-trading.co",
      passwordHash: await bcrypt.hash("gritdemo1", 12),
      name: "Trading Co Admin",
      role: "OWNER",
    },
  });

  let variant = await db.variant.findFirst({ where: { tenantId: tenant.id, sku: "GLV-M" } });
  if (!variant) {
    const product = await db.product.create({
      data: {
        tenantId: tenant.id,
        name: "Safety Gloves",
        description: "Cut-resistant work gloves, sold by size",
        supplierName: "SafeGuard PPE Distributors",
      },
    });

    const [small, medium, large] = await Promise.all([
      db.variant.create({
        data: { tenantId: tenant.id, productId: product.id, sku: "GLV-S", name: "Small", price: 8.5, unitCost: 3.2, quantityOnHand: 0, reorderThreshold: 10 },
      }),
      db.variant.create({
        data: { tenantId: tenant.id, productId: product.id, sku: "GLV-M", name: "Medium", price: 8.5, unitCost: 3.2, quantityOnHand: 0, reorderThreshold: 10 },
      }),
      db.variant.create({
        data: { tenantId: tenant.id, productId: product.id, sku: "GLV-L", name: "Large", price: 9.0, unitCost: 3.2, quantityOnHand: 0, reorderThreshold: 10 },
      }),
    ]);
    variant = medium;

    // Showroom starts empty (reorder threshold set; stock arrives via transfer).
    for (const v of [small, medium, large]) {
      await db.storeStock.create({
        data: { tenantId: tenant.id, storeId: showroom.id, variantId: v.id, quantityOnHand: 0, reorderThreshold: 10 },
      });
    }

    // Warehouse: two restock batches at DIFFERENT costs for Medium — a real
    // multi-lot FIFO scenario (older/cheaper lot drains first).
    await db.storeStock.create({
      data: { tenantId: tenant.id, storeId: warehouse.id, variantId: medium.id, quantityOnHand: 200, reorderThreshold: 20 },
    });
    await db.stockLot.create({
      data: { tenantId: tenant.id, storeId: warehouse.id, variantId: medium.id, quantityReceived: 100, quantityRemaining: 100, unitCost: 3.2, receivedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
    });
    await db.stockLot.create({
      data: { tenantId: tenant.id, storeId: warehouse.id, variantId: medium.id, quantityReceived: 100, quantityRemaining: 100, unitCost: 3.75, receivedAt: new Date() },
    });
    await db.variant.update({ where: { id: medium.id }, data: { quantityOnHand: 200 } });

    // Small/Large: a modest single-lot warehouse stock too, for realism.
    for (const v of [small, large]) {
      await db.storeStock.create({
        data: { tenantId: tenant.id, storeId: warehouse.id, variantId: v.id, quantityOnHand: 60, reorderThreshold: 15 },
      });
      await db.stockLot.create({
        data: { tenantId: tenant.id, storeId: warehouse.id, variantId: v.id, quantityReceived: 60, quantityRemaining: 60, unitCost: 3.2 },
      });
      await db.variant.update({ where: { id: v.id }, data: { quantityOnHand: 60 } });
    }
  }

  console.log(`Inventory trading-co demo seeded for organization_id=${tenant.id}`);
  console.log(`Showroom (default) store id: ${showroom.id}`);
  console.log(`Central Warehouse store id: ${warehouse.id}`);
  console.log(`GLV-M variant id: ${variant.id}`);
  console.log("Login: admin@grit-trading.co / gritdemo1");
}

main().finally(() => db.$disconnect());
