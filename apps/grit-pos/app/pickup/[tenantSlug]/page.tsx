import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveTenantBySlug } from "@/app/api/pickup/_resolve";
import { PickupOrderingApp } from "@/components/pickup/PickupOrderingApp";
import type { CatalogCategory } from "@/components/pickup/types";

// Customer-facing standalone pickup landing page: /pickup/{tenantSlug}. No
// login, no table — the tenant's own unique slug is the identifier.
// Renders the full catalog server-side for a fast first paint; the client
// component then owns cart state and talks to app/api/pickup/**.

export default async function PickupPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  // Gated resolver: also returns null (-> generic 404) when the tenant has
  // the "hospitality.pickup_links" plugin trait disabled.
  const tenant = await resolveTenantBySlug(tenantSlug);
  if (!tenant) {
    // Generic 404 — see app/pickup/[tenantSlug]/not-found.tsx. Deliberately
    // does not distinguish "malformed slug" from "unknown slug".
    notFound();
  }

  const categories = await prisma.category.findMany({
    where: { tenantId: tenant.id },
    orderBy: { sortOrder: "asc" },
    include: {
      products: {
        where: { isActive: true },
        orderBy: { name: "asc" },
        include: {
          variants: { orderBy: { name: "asc" } },
          addOns: { orderBy: { name: "asc" } },
        },
      },
    },
  });

  const catalog: CatalogCategory[] = categories
    .filter((category) => category.products.length > 0)
    .map((category) => ({
      id: category.id,
      name: category.name,
      products: category.products.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description,
        basePrice: Number(product.basePrice),
        variants: product.variants.map((variant) => ({
          id: variant.id,
          name: variant.name,
          priceDelta: Number(variant.priceDelta),
        })),
        addOns: product.addOns.map((addOn) => ({
          id: addOn.id,
          name: addOn.name,
          price: Number(addOn.price),
        })),
      })),
    }));

  return <PickupOrderingApp tenantSlug={tenantSlug} tenantName={tenant.name} catalog={catalog} />;
}
