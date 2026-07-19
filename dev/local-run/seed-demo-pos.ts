// Seeds the local grit_pos database with a SCALE-tier demo tenant, an owner
// login, and a variant-matrix product whose child SKUs match the
// grit-inventory demo seed — so a POS sale drives the full cross-app event
// chain. Run: DATABASE_URL=postgresql://... npx tsx dev/local-run/seed-demo-pos.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { createRequire } from "node:module";
const requireFromApp = createRequire(new URL("../../apps/grit-pos/package.json", import.meta.url));
const bcrypt = requireFromApp("bcryptjs") as typeof import("bcryptjs");
import { PrismaClient } from "../../apps/grit-pos/app/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-cafe" },
    update: {
      tier: "SCALE",
      addons: ["custom_reporting"],
      enabledTraits: ["hospitality.tables", "hospitality.pickup_links", "retail.variant_matrix"],
    },
    create: {
      name: "Demo Cafe",
      slug: "demo-cafe",
      tier: "SCALE",
      addons: ["custom_reporting"],
      enabledTraits: ["hospitality.tables", "hospitality.pickup_links", "retail.variant_matrix"],
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "owner@demo.cafe" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "owner@demo.cafe",
      passwordHash: await bcrypt.hash("gritdemo1", 12),
      role: "owner",
    },
  });

  const category = await prisma.category.findFirst({
    where: { tenantId: tenant.id, name: "Apparel" },
  }) ?? await prisma.category.create({
    data: { tenantId: tenant.id, name: "Apparel", sortOrder: 1 },
  });

  const existing = await prisma.product.findFirst({
    where: { tenantId: tenant.id, name: "Grit Tee" },
    include: { variants: true },
  });
  if (!existing) {
    await prisma.product.create({
      data: {
        tenantId: tenant.id,
        categoryId: category.id,
        name: "Grit Tee",
        description: "Demo variant-matrix product",
        basePrice: 25.0,
        isActive: true,
        variants: {
          create: [
            { name: "Black / L", priceDelta: 0, tenantId: tenant.id, sku: "SKU-BLK-L", attributes: { size: "L", color: "black" } },
            { name: "Black / M", priceDelta: 0, tenantId: tenant.id, sku: "SKU-BLK-M", attributes: { size: "M", color: "black" } },
          ],
        },
      },
    });
  }

  console.log(`POS demo seeded. organization_id=${tenant.id}`);
  console.log("Login: owner@demo.cafe / gritdemo1 (slug demo-cafe)");
}

main().finally(() => prisma.$disconnect());
