import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const STORE_TYPES = ["retail", "warehouse", "service_hub", "kitchen"] as const;

const updateStoreSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(STORE_TYPES).optional(),
});

/** PATCH /api/stores/[id] — rename / retype a store. Renaming the default
 * store is allowed on every tier; touching any other store requires
 * `inventory.multi_location`. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  const { id } = await params;

  const store = await db.store.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!store) return apiError("Store not found", 404);

  if (!store.isDefault) {
    try {
      assertFeature(ctx.grit, "inventory.multi_location");
    } catch (err) {
      const res = entitlementResponse(err);
      if (res) return res;
      throw err;
    }
  }

  const body = await request.json().catch(() => null);
  const parsed = updateStoreSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }

  const updated = await db.store.update({ where: { id: store.id }, data: parsed.data });
  return NextResponse.json({ store: updated });
}

/** DELETE /api/stores/[id] — the default store can never be deleted; other
 * stores only when they hold no stock and no transfer history references
 * them. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  const { id } = await params;

  const store = await db.store.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!store) return apiError("Store not found", 404);
  if (store.isDefault) return apiError("The default store cannot be deleted", 400);

  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const stocked = await db.storeStock.count({
    where: { storeId: store.id, quantityOnHand: { gt: 0 } },
  });
  if (stocked > 0) {
    return apiError("Store still holds stock — transfer it out before deleting", 409);
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.storeStock.deleteMany({ where: { storeId: store.id } });
      await tx.store.delete({ where: { id: store.id } });
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2003") {
      return apiError(
        "Store is referenced by history (movements, transfers, or users) and cannot be deleted",
        409
      );
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
