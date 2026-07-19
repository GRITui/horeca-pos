import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const assignSchema = z.object({ productId: z.string().min(1) });

/** GET /api/item-sub-groups/[id]/products — products currently assigned to
 * this sub-group. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const subGroup = await db.itemSubGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!subGroup) return apiError("Sub-group not found", 404);

  const products = await db.product.findMany({
    where: { subGroupId: subGroup.id, tenantId: ctx.local.tenantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, supplierName: true, isActive: true },
  });
  return NextResponse.json({ products });
}

/** POST /api/item-sub-groups/[id]/products — assign a product to this
 * sub-group (sets `Product.subGroupId`). This is the only way product↔group
 * assignment happens; the product pages themselves don't expose it. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const subGroup = await db.itemSubGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!subGroup) return apiError("Sub-group not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid request");
  }

  const product = await db.product.findFirst({
    where: { id: parsed.data.productId, tenantId: ctx.local.tenantId },
  });
  if (!product) return apiError("Product not found", 404);

  const updated = await db.product.update({
    where: { id: product.id },
    data: { subGroupId: subGroup.id },
    select: { id: true, name: true, supplierName: true, isActive: true },
  });
  return NextResponse.json({ product: updated });
}

/** DELETE /api/item-sub-groups/[id]/products — unassign a product from this
 * sub-group (sets `Product.subGroupId` back to null). Body: {productId}. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const subGroup = await db.itemSubGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!subGroup) return apiError("Sub-group not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid request");
  }

  const product = await db.product.findFirst({
    where: { id: parsed.data.productId, tenantId: ctx.local.tenantId, subGroupId: subGroup.id },
  });
  if (!product) return apiError("Product is not assigned to this sub-group", 404);

  await db.product.update({ where: { id: product.id }, data: { subGroupId: null } });
  return NextResponse.json({ ok: true });
}
