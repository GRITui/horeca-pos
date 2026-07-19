import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { applyStockMovement } from "@/lib/inventory";

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // Grit pivot: published on inventory.threshold_breached events.
  supplierName: z.string().optional(),
  initialVariant: z
    .object({
      sku: z.string().min(1),
      name: z.string().min(1),
      price: z.number().nonnegative(),
      // Grit pivot: acquisition cost — seeds the initial FIFO lot.
      unitCost: z.number().nonnegative().optional(),
      quantityOnHand: z.number().int().min(0).default(0),
      reorderThreshold: z.number().int().min(0).default(0),
    })
    .optional(),
});

export async function GET(request: NextRequest) {
  const session = await requireApiSession();
  // Grit BizSuite pivot: optional `?q=` search-by-name, used by the item
  // groups admin (src/app/admin/groups) to find products to assign to a
  // sub-group without pulling every product in the tenant.
  const q = request.nextUrl.searchParams.get("q")?.trim();
  const products = await db.product.findMany({
    where: {
      tenantId: session.tenantId,
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    include: { variants: true },
    orderBy: { createdAt: "desc" },
    ...(q ? { take: 25 } : {}),
  });
  return NextResponse.json({ products });
}

export async function POST(request: NextRequest) {
  const session = await requireApiSession();
  const body = await request.json().catch(() => null);
  const parsed = createProductSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid product");
  }

  const { name, description, supplierName, initialVariant } = parsed.data;

  try {
    const product = await db.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          tenantId: session.tenantId,
          name,
          description,
          supplierName,
          ...(initialVariant && {
            variants: {
              create: {
                tenantId: session.tenantId,
                sku: initialVariant.sku,
                name: initialVariant.name,
                price: initialVariant.price,
                unitCost: initialVariant.unitCost,
                // Stock is applied below via applyStockMovement so the
                // per-store StoreStock row and FIFO lot are created too.
                quantityOnHand: 0,
                reorderThreshold: initialVariant.reorderThreshold,
              },
            },
          }),
        },
        include: { variants: true },
      });

      if (initialVariant && initialVariant.quantityOnHand > 0) {
        await applyStockMovement(tx, {
          tenantId: session.tenantId,
          storeId: session.storeId,
          variantId: created.variants[0].id,
          delta: initialVariant.quantityOnHand,
          reason: "manual_adjustment",
          note: "Initial stock on product creation",
          createdById: session.sub,
          unitCost: initialVariant.unitCost,
        });
      }

      return tx.product.findUniqueOrThrow({
        where: { id: created.id },
        include: { variants: true },
      });
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A variant with that SKU already exists", 409);
    }
    throw err;
  }
}
