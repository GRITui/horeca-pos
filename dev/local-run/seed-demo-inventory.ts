// Seeds the local grit_inventory database with a tenant whose id EQUALS the
// POS demo tenant id (org-id equality is the cross-app tenancy mapping), a
// default store, and stock for the shared demo SKU — 5 on hand, reorder
// threshold 3, so a 3-unit POS sale crosses the threshold and fires
// inventory.threshold_breached.
// Run: DATABASE_URL=... DEMO_ORG_ID=<pos tenant id> npx tsx dev/local-run/seed-demo-inventory.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { createRequire } from "node:module";
const requireFromApp = createRequire(new URL("../../apps/grit-inventory/package.json", import.meta.url));
const bcrypt = requireFromApp("bcryptjs") as typeof import("bcryptjs");
import { PrismaClient } from "../../apps/grit-inventory/src/generated/prisma/client";

const orgId = process.env.DEMO_ORG_ID;
if (!orgId) throw new Error("DEMO_ORG_ID (the POS demo tenant id) is required");

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const tenant = await db.tenant.upsert({
    where: { id: orgId },
    update: { tier: "SCALE", addons: ["custom_reporting"] },
    create: {
      id: orgId,
      name: "Demo Cafe",
      slug: "demo-cafe",
      tier: "SCALE",
      addons: ["custom_reporting"],
    },
  });

  let store = await db.store.findFirst({ where: { tenantId: tenant.id, isDefault: true } });
  store ??= await db.store.create({
    data: { tenantId: tenant.id, name: "Main Store", isDefault: true, type: "retail" },
  });

  await db.user.upsert({
    where: { email: "admin@demo.cafe" },
    update: {},
    create: {
      tenantId: tenant.id,
      storeId: store.id,
      email: "admin@demo.cafe",
      passwordHash: await bcrypt.hash("gritdemo1", 12),
      name: "Demo Admin",
      role: "OWNER",
    },
  });

  let variant = await db.variant.findFirst({
    where: { tenantId: tenant.id, sku: "SKU-BLK-L" },
  });
  if (!variant) {
    const product = await db.product.create({
      data: {
        tenantId: tenant.id,
        name: "Grit Tee",
        description: "Demo variant-matrix product",
        supplierName: "Grit Threads Co.",
      },
    });
    variant = await db.variant.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        sku: "SKU-BLK-L",
        name: "Black / L",
        price: 25.0,
        unitCost: 10.0,
        quantityOnHand: 5,
        reorderThreshold: 3,
      },
    });
    await db.storeStock.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        variantId: variant.id,
        quantityOnHand: 5,
        reorderThreshold: 3,
      },
    });
    await db.stockLot.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        variantId: variant.id,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: 10.0,
      },
    });
  }

  console.log(`Inventory demo seeded for organization_id=${tenant.id} (store ${store.id})`);
  console.log("Login: admin@demo.cafe / gritdemo1");
}

main().finally(() => db.$disconnect());
