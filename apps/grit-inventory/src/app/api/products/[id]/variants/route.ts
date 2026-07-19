import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { applyStockMovement } from "@/lib/inventory";

const createVariantSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  // Grit pivot: acquisition cost — seeds the initial FIFO lot.
  unitCost: z.number().nonnegative().optional(),
  quantityOnHand: z.number().int().min(0).default(0),
  reorderThreshold: z.number().int().min(0).default(0),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id: productId } = await params;

  const product = await db.product.findFirst({ where: { id: productId, tenantId: session.tenantId } });
  if (!product) return apiError("Product not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = createVariantSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid variant");
  }
  const data = parsed.data;

  try {
    const variant = await db.$transaction(async (tx) => {
      const created = await tx.variant.create({
        data: {
          tenantId: session.tenantId,
          productId,
          sku: data.sku,
          name: data.name,
          price: data.price,
          unitCost: data.unitCost,
          // Stock is applied below via applyStockMovement so the per-store
          // StoreStock row and FIFO lot are created too.
          quantityOnHand: 0,
          reorderThreshold: data.reorderThreshold,
        },
      });

      if (data.quantityOnHand > 0) {
        await applyStockMovement(tx, {
          tenantId: session.tenantId,
          storeId: session.storeId,
          variantId: created.id,
          delta: data.quantityOnHand,
          reason: "manual_adjustment",
          note: "Initial stock on variant creation",
          createdById: session.sub,
          unitCost: data.unitCost,
        });
      }

      return tx.variant.findUniqueOrThrow({ where: { id: created.id } });
    });

    return NextResponse.json({ variant }, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A variant with that SKU already exists", 409);
    }
    throw err;
  }
}
