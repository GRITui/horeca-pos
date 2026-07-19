import { prisma } from "@/lib/prisma";
import {
  enforceRateLimit,
  handlePreflight,
  INVALID_PICKUP_LINK_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/pickup/_utils";
import { resolveTenantBySlug } from "@/app/api/pickup/_resolve";

// GET /api/pickup/:tenantSlug/catalog
// Returns the active menu (categories -> products -> variants/add-ons) for
// the tenant behind this standalone pickup link. Read-only, unauthenticated,
// tenant-scoped strictly through the resolved slug — never through
// client-supplied ids. Same shape/pattern as the QR table catalog route.

export function OPTIONS() {
  return handlePreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantSlug: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { tenantSlug } = await params;
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    return jsonError(INVALID_PICKUP_LINK_MESSAGE, 404);
  }

  const categories = await prisma.category.findMany({
    where: { tenantId: resolved.id },
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

  return jsonOk({
    categories: categories
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
      })),
  });
}
