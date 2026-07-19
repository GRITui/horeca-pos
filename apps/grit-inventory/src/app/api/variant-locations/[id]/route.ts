import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const updateVariantLocationSchema = z.object({
  code: z.string().min(1).optional(),
  zone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

/** PATCH /api/variant-locations/[id] — edit a planogram slot. Setting
 * `isPrimary: true` flips any other primary row for the same
 * (storeId, variantId) to false in the same transaction (app-level
 * exclusivity — see README "Warehouse operations schema"). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  if (!hasRole(session.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const existing = await db.variantLocation.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Location not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = updateVariantLocationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const { isPrimary, ...fields } = parsed.data;

  const location = await db.$transaction(async (tx) => {
    if (isPrimary) {
      await tx.variantLocation.updateMany({
        where: {
          tenantId: session.tenantId,
          storeId: existing.storeId,
          variantId: existing.variantId,
          isPrimary: true,
          id: { not: existing.id },
        },
        data: { isPrimary: false },
      });
    }
    return tx.variantLocation.update({
      where: { id: existing.id },
      data: { ...fields, ...(isPrimary !== undefined ? { isPrimary } : {}) },
      include: {
        variant: { select: { id: true, sku: true, name: true, product: { select: { name: true } } } },
        store: { select: { id: true, name: true } },
      },
    });
  });

  return NextResponse.json({ location });
}

/** DELETE /api/variant-locations/[id] — remove a planogram slot. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  if (!hasRole(session.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const existing = await db.variantLocation.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Location not found", 404);

  await db.variantLocation.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true });
}
