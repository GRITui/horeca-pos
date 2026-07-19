import { notFound } from "next/navigation";
import { verifyTableToken } from "@/lib/tokenLink";
import { prisma } from "@/lib/prisma";
import { TableOrderingApp } from "@/components/qr/TableOrderingApp";
import type { CatalogCategory } from "@/components/qr/types";

// Customer-facing QR landing page: /t/{tableToken}. No login — the token
// itself is the (scoped) access grant, resolved via verifyTableToken().
// Renders the full catalog server-side for a fast first paint; the client
// component then owns cart state and talks to app/api/public/table/**.

export default async function TablePage({
  params,
}: {
  params: Promise<{ tableToken: string }>;
}) {
  const { tableToken } = await params;

  const table = await verifyTableToken(tableToken);
  if (!table) {
    // Generic 404 — see app/t/[tableToken]/not-found.tsx. Deliberately does
    // not distinguish "malformed token" from "unknown token" from any
    // other-tenant detail.
    notFound();
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: table.tenantId },
    select: { name: true },
  });
  if (!tenant) {
    notFound();
  }

  const categories = await prisma.category.findMany({
    where: { tenantId: table.tenantId },
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

  return (
    <TableOrderingApp
      tableToken={tableToken}
      tenantName={tenant.name}
      tableLabel={table.label}
      catalog={catalog}
    />
  );
}
