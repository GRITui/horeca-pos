import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";

neonConfig.webSocketConstructor = ws;

// Local dev: a localhost DATABASE_URL (plain Postgres) can't use the Neon
// websocket driver — fall back to node-postgres, same as src/lib/db.ts.
function makeAdapter() {
  const connectionString = process.env.DATABASE_URL;
  try {
    const host = new URL(connectionString ?? "").hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PrismaPg } = require("@prisma/adapter-pg") as { PrismaPg: typeof PrismaNeon };
      return new PrismaPg({ connectionString: connectionString! });
    }
  } catch {
    // fall through to Neon adapter, which will surface the real error
  }
  return new PrismaNeon({ connectionString });
}

const db = new PrismaClient({ adapter: makeAdapter() });

async function main() {
  const tenant = await db.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Tenant", slug: "demo" },
  });

  const store = await db.store.upsert({
    where: { id: `${tenant.id}-main-store` },
    update: {},
    create: {
      id: `${tenant.id}-main-store`,
      tenantId: tenant.id,
      name: "Main Store",
      isDefault: true,
    },
  });

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@demo.invento";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await db.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      tenantId: tenant.id,
      storeId: store.id,
      email: adminEmail,
      passwordHash,
      name: "Admin",
      role: "OWNER",
    },
  });

  const product = await db.product.upsert({
    where: { id: `${tenant.id}-demo-product` },
    update: {},
    create: {
      id: `${tenant.id}-demo-product`,
      tenantId: tenant.id,
      name: "Sample T-Shirt",
      description: "Seed data for local development.",
    },
  });

  await db.variant.upsert({
    where: { tenantId_sku: { tenantId: tenant.id, sku: "TSHIRT-M-BLK" } },
    update: {},
    create: {
      tenantId: tenant.id,
      productId: product.id,
      sku: "TSHIRT-M-BLK",
      name: "Medium / Black",
      price: 19.99,
      quantityOnHand: 50,
      reorderThreshold: 10,
    },
  });

  await db.variant.upsert({
    where: { tenantId_sku: { tenantId: tenant.id, sku: "TSHIRT-L-BLK" } },
    update: {},
    create: {
      tenantId: tenant.id,
      productId: product.id,
      sku: "TSHIRT-L-BLK",
      name: "Large / Black",
      price: 19.99,
      quantityOnHand: 3,
      reorderThreshold: 10,
    },
  });

  console.log(`Seeded tenant "${tenant.slug}". Admin login: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
