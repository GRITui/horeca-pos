import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext, assertStoreAccess } from "@/lib/passport";

const updateVariantSchema = z.object({
  name: z.string().min(1).optional(),
  // Grit pivot: barcode-scanner "assign SKU to variant" flow.
  sku: z.string().min(1).optional(),
  price: z.number().nonnegative().optional(),
  // Grit pivot: default acquisition cost (FIFO lot default / fallback).
  unitCost: z.number().nonnegative().nullable().optional(),
  reorderThreshold: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  stockAdjustment: z
    .object({
      delta: z.number().int().refine((n) => n !== 0, "Adjustment cannot be zero"),
      note: z.string().optional(),
      // Grit pivot: per-store operations. Omitted -> the tenant's default
      // store. Non-default stores require `inventory.multi_location`.
      storeId: z.string().min(1).optional(),
      // Cost of the received units (positive adjustments create a FIFO lot).
      unitCost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  const { id } = await params;

  const existing = await db.variant.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Variant not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = updateVariantSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const { stockAdjustment, ...fields } = parsed.data;

  if (stockAdjustment) {
    // Gate the store the adjustment will actually land on — explicit
    // `storeId`, or the session's store when omitted (applyStockMovement
    // falls back to it below). Only skipping the check entirely when neither
    // is set (falls through to the tenant default store, always accessible).
    const targetStoreId = stockAdjustment.storeId ?? session.storeId;
    if (targetStoreId) {
      const store = await db.store.findFirst({
        where: { id: targetStoreId, tenantId: session.tenantId },
      });
      if (!store) return apiError("Store not found", 404);
      try {
        assertStoreAccess(ctx.grit, store);
      } catch (err) {
        const res = entitlementResponse(err);
        if (res) return res;
        throw err;
      }
    }
  }

  try {
    const variant = await db.$transaction(async (tx) => {
      if (Object.keys(fields).length > 0) {
        await tx.variant.update({ where: { id }, data: fields });
        if (fields.reorderThreshold !== undefined) {
          // Keep the default store's per-store threshold in step with the
          // variant-level threshold existing screens edit.
          const defaultStore = await tx.store.findFirst({
            where: { tenantId: session.tenantId, isDefault: true },
            orderBy: { createdAt: "asc" },
          });
          if (defaultStore) {
            await tx.storeStock.updateMany({
              where: { tenantId: session.tenantId, variantId: id, storeId: defaultStore.id },
              data: { reorderThreshold: fields.reorderThreshold },
            });
          }
        }
      }
      if (stockAdjustment) {
        await applyStockMovement(tx, {
          tenantId: session.tenantId,
          storeId: stockAdjustment.storeId ?? session.storeId,
          variantId: id,
          delta: stockAdjustment.delta,
          reason: "manual_adjustment",
          note: stockAdjustment.note,
          createdById: session.sub,
          unitCost: stockAdjustment.unitCost,
        });
      }
      return tx.variant.findUniqueOrThrow({ where: { id } });
    });

    return NextResponse.json({ variant });
  } catch (err: unknown) {
    if (err instanceof InsufficientStockError) {
      return apiError("Adjustment would make stock negative", 409);
    }
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A variant with that SKU already exists", 409);
    }
    throw err;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  if (!hasRole(session.role, "ADMIN")) return apiError("Forbidden", 403);
  const { id } = await params;

  const existing = await db.variant.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Variant not found", 404);

  await db.variant.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ ok: true });
}
