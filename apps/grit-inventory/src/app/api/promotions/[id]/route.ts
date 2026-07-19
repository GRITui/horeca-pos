import { NextRequest, NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import {
  fetchExcludedPromotionIds,
  fetchPromotionScopeById,
  fetchPromotionWithScope,
  publishPromotionUpdate,
  syncPromotionExclusions,
  validateExclusionOwnership,
} from "@/lib/promotions";
import { createPromotionSchema } from "../route";

/** GET /api/promotions/[id] — one promotion with its scope, for the edit
 * form. */
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
  const promotion = await fetchPromotionWithScope(id, ctx.local.tenantId);
  if (!promotion) return apiError("Promotion not found", 404);
  const excludedPromotionIds = await fetchExcludedPromotionIds(id);
  return NextResponse.json({ promotion: { ...promotion, excludedPromotionIds } });
}

async function validateScopeOwnership(
  tenantId: string,
  variantIds: string[],
  subGroupIds: string[]
): Promise<string | null> {
  if (variantIds.length > 0) {
    const count = await db.variant.count({ where: { id: { in: variantIds }, tenantId } });
    if (count !== new Set(variantIds).size) return "One or more variants not found";
  }
  if (subGroupIds.length > 0) {
    const count = await db.itemSubGroup.count({ where: { id: { in: subGroupIds }, tenantId } });
    if (count !== new Set(subGroupIds).size) return "One or more sub-groups not found";
  }
  return null;
}

/**
 * PATCH /api/promotions/[id] — full replace of a promotion's core fields
 * and scope (edit form submits the whole desired state, same schema as
 * create — including flipping `isActive` off, which is how "deactivate"
 * works from this endpoint). Publishes `promotion.updated`; `deleted` is
 * true in the published event whenever the resulting `isActive` is false,
 * so a deactivate has the same effect on POS's cache as a hard delete.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const existing = await db.promotion.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!existing) return apiError("Promotion not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = createPromotionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid promotion");
  }
  const data = parsed.data;
  const variantIds = data.variantIds.map((v) => v.variantId);
  const subGroupIds = "subGroupIds" in data ? data.subGroupIds : [];

  const scopeError = await validateScopeOwnership(ctx.local.tenantId, variantIds, subGroupIds);
  if (scopeError) return apiError(scopeError, 404);

  const exclusionError = await validateExclusionOwnership(ctx.local.tenantId, id, data.excludedPromotionIds);
  if (exclusionError) return apiError(exclusionError, 404);

  const dedupedVariants = Array.from(
    new Map(data.variantIds.map((v) => [v.variantId, v.requiredQuantity])).entries()
  );

  await db.$transaction(async (tx) => {
    await tx.promotionVariant.deleteMany({ where: { promotionId: id } });
    await tx.promotionGroup.deleteMany({ where: { promotionId: id } });
    await tx.promotion.update({
      where: { id },
      data: {
        name: data.name,
        type: data.type,
        isActive: data.isActive,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
        buyQuantity: data.type === "buy_x_pay_y" ? data.buyQuantity : null,
        payQuantity: data.type === "buy_x_pay_y" ? data.payQuantity : null,
        minQuantity: data.type === "buy_x_get_discount" ? data.minQuantity : null,
        discountKind: data.type === "buy_x_get_discount" ? data.discountKind : null,
        discountValue: data.type === "buy_x_get_discount" ? data.discountValue : null,
        bundlePrice: data.type === "bundle_deal" ? data.bundlePrice : null,
        scopeVariants: {
          create: dedupedVariants.map(([variantId, requiredQuantity]) => ({ variantId, requiredQuantity })),
        },
        scopeGroups: { create: subGroupIds.map((subGroupId) => ({ subGroupId })) },
      },
    });
    await syncPromotionExclusions(tx, ctx.local.tenantId, id, data.excludedPromotionIds);
  });

  const scoped = await fetchPromotionScopeById(id);
  await publishPromotionUpdate(ctx.local.tenantId, scoped, { deleted: false });

  return NextResponse.json({ promotion: scoped });
}

/**
 * DELETE /api/promotions/[id] — hard delete (cascades PromotionVariant /
 * PromotionGroup). Publishes `promotion.updated` with `deleted: true`,
 * resolved from the scope as it existed immediately before deletion.
 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const promotion = await fetchPromotionWithScope(id, ctx.local.tenantId);
  if (!promotion) return apiError("Promotion not found", 404);

  await db.promotion.delete({ where: { id } });
  await publishPromotionUpdate(ctx.local.tenantId, promotion, { deleted: true });

  return NextResponse.json({ ok: true });
}
