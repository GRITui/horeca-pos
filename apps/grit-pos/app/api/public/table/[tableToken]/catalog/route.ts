import { prisma } from "@/lib/prisma";
import {
  enforceRateLimit,
  handlePreflight,
  INVALID_TABLE_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/public/_utils";
import { resolveTableByToken } from "@/app/api/public/table/_resolve";

// GET /api/public/table/:tableToken/catalog
// Returns the active menu (categories -> products -> variants/add-ons) for
// the tenant that owns the scanned table. Read-only, unauthenticated,
// tenant-scoped strictly through the verified token — never through
// client-supplied ids.

export function OPTIONS() {
  return handlePreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tableToken: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { tableToken } = await params;
  const resolved = await resolveTableByToken(tableToken);
  if (!resolved) {
    return jsonError(INVALID_TABLE_MESSAGE, 404);
  }

  const categories = await prisma.category.findMany({
    where: { tenantId: resolved.tenantId },
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
