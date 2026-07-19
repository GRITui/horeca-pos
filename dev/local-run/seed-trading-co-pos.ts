// Seeds the local grit_pos database with a SCALE-tier "trading company"
// demo tenant — hospitality traits OFF (no tables, no pickup links), retail
// variant matrix ON — a distributor selling PPE/industrial supplies, with
// SKUs matching the grit-inventory trading-co seed so a POS sale drives the
// full cross-app event chain under this persona.
// Run: DATABASE_URL=postgresql://... npx tsx dev/local-run/seed-trading-co-pos.ts
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
    where: { slug: "grit-trading" },
    update: {
      tier: "SCALE",
      addons: ["custom_reporting"],
      enabledTraits: ["retail.variant_matrix"],
    },
    create: {
      name: "Grit Trading Co.",
      slug: "grit-trading",
      tier: "SCALE",
      addons: ["custom_reporting"],
      enabledTraits: ["retail.variant_matrix"],
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "owner@grit-trading.co" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "owner@grit-trading.co",
      passwordHash: await bcrypt.hash("gritdemo1", 12),
      role: "owner",
    },
  });

  const category = await prisma.category.findFirst({
    where: { tenantId: tenant.id, name: "Industrial Supplies" },
  }) ?? await prisma.category.create({
    data: { tenantId: tenant.id, name: "Industrial Supplies", sortOrder: 1 },
  });

  const existing = await prisma.product.findFirst({
    where: { tenantId: tenant.id, name: "Safety Gloves" },
    include: { variants: true },
  });
  if (!existing) {
    await prisma.product.create({
      data: {
        tenantId: tenant.id,
        categoryId: category.id,
        name: "Safety Gloves",
        description: "Cut-resistant work gloves, sold by size",
        basePrice: 8.5,
        isActive: true,
        variants: {
          create: [
            { name: "Small", priceDelta: 0, tenantId: tenant.id, sku: "GLV-S", attributes: { size: "S" } },
            { name: "Medium", priceDelta: 0, tenantId: tenant.id, sku: "GLV-M", attributes: { size: "M" } },
            { name: "Large", priceDelta: 0.5, tenantId: tenant.id, sku: "GLV-L", attributes: { size: "L" } },
          ],
        },
      },
    });
  }

  console.log(`POS trading-co demo seeded. organization_id=${tenant.id}`);
  console.log("Login: owner@grit-trading.co / gritdemo1 (slug grit-trading)");
  console.log("Hospitality traits: OFF. retail.variant_matrix: ON.");
}

main().finally(() => prisma.$disconnect());
