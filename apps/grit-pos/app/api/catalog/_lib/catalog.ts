import "server-only";

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { parseAttributes } from "@/lib/variantMatrix";

// ---------------------------------------------------------------------------
// Staff-facing, tenant-scoped catalog read. Only active products are
// returned — the POS shouldn't let staff ring up something that's been
// deactivated. Shared between GET /api/catalog and the POS server
// components (app/(staff)/pos/**) so both see identical data.
// ---------------------------------------------------------------------------

const catalogInclude = {
  products: {
    where: { isActive: true },
    orderBy: { name: "asc" },
    include: {
      variants: { orderBy: { name: "asc" } },
      addOns: { orderBy: { name: "asc" } },
    },
  },
} as const satisfies Prisma.CategoryInclude;

export type CategoryWithProducts = Prisma.CategoryGetPayload<{
  include: typeof catalogInclude;
}>;

export async function getCatalogForTenant(tenantId: string): Promise<CategoryWithProducts[]> {
  return prisma.category.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: catalogInclude,
  });
}

// -- DTO shaping ---------------------------------------------------------

export interface CatalogAddOnDTO {
  id: string;
  name: string;
  price: number;
}

export interface CatalogVariantDTO {
  id: string;
  name: string;
  priceDelta: number;
  /** Retail variant matrix: optional child SKU (unique per tenant). */
  sku: string | null;
  /** Retail variant matrix: attribute combination, e.g. {size:'L',color:'black'}. */
  attributes: Record<string, string> | null;
}

export interface CatalogProductDTO {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  variants: CatalogVariantDTO[];
  addOns: CatalogAddOnDTO[];
}

export interface CatalogCategoryDTO {
  id: string;
  name: string;
  products: CatalogProductDTO[];
}

export function serializeCatalog(categories: CategoryWithProducts[]): CatalogCategoryDTO[] {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    products: category.products.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      basePrice: Number(product.basePrice),
      variants: product.variants.map((v) => ({
        id: v.id,
        name: v.name,
        priceDelta: Number(v.priceDelta),
        sku: v.sku ?? null,
        attributes: parseAttributes(v.attributes),
      })),
      addOns: product.addOns.map((a) => ({
        id: a.id,
        name: a.name,
        price: Number(a.price),
      })),
    })),
  }));
}
