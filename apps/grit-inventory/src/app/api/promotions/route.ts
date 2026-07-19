import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import {
  fetchPromotionScopeById,
  publishPromotionUpdate,
  syncPromotionExclusions,
  validateExclusionOwnership,
} from "@/lib/promotions";

/**
 * Grit BizSuite pivot: pricing/promotion rules admin. SCALE only, reusing
 * the existing `inventory.multi_location` feature key (no new key added —
 * same convention as Groups/Locations/Transfers).
 */

const variantScopeItemSchema = z.object({
  variantId: z.string().min(1),
  requiredQuantity: z.number().int().positive().default(1),
});

const scopeFieldsSchema = z.object({
  variantIds: z.array(variantScopeItemSchema).default([]),
  subGroupIds: z.array(z.string().min(1)).default([]),
});

const baseSchema = z.object({
  name: z.string().min(1),
  isActive: z.boolean().default(true),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  /** Discount resolution policy (BACKLOG.md), layer 2: other promotion ids
   * this rule must never co-apply with on the same order. Applies to every
   * promotion type — independent of `type`-specific scope fields. */
  excludedPromotionIds: z.array(z.string().min(1)).default([]),
});

const buyXPayYSchema = baseSchema
  .extend({
    type: z.literal("buy_x_pay_y"),
    buyQuantity: z.number().int().positive(),
    payQuantity: z.number().int().positive(),
  })
  .merge(scopeFieldsSchema)
  .refine((v) => v.payQuantity <= v.buyQuantity, {
    message: "payQuantity must be less than or equal to buyQuantity",
    path: ["payQuantity"],
  })
  .refine((v) => v.variantIds.length > 0 || v.subGroupIds.length > 0, {
    message: "Select at least one variant or sub-group to scope this rule to",
    path: ["variantIds"],
  });

const buyXGetDiscountSchema = baseSchema
  .extend({
    type: z.literal("buy_x_get_discount"),
    minQuantity: z.number().int().positive(),
    discountKind: z.enum(["percent", "fixed_amount"]),
    discountValue: z.number().positive(),
  })
  .merge(scopeFieldsSchema)
  .refine((v) => v.discountKind !== "percent" || v.discountValue <= 100, {
    message: "A percent discount cannot exceed 100",
    path: ["discountValue"],
  })
  .refine((v) => v.variantIds.length > 0 || v.subGroupIds.length > 0, {
    message: "Select at least one variant or sub-group to scope this rule to",
    path: ["variantIds"],
  });

const bundleDealSchema = baseSchema.extend({
  type: z.literal("bundle_deal"),
  bundlePrice: z.number().positive(),
  variantIds: z.array(variantScopeItemSchema).min(1, "Select at least one variant for the bundle"),
});

export const createPromotionSchema = z.discriminatedUnion("type", [
  buyXPayYSchema,
  buyXGetDiscountSchema,
  bundleDealSchema,
]);

/** Confirms every referenced variant/sub-group id belongs to the tenant.
 * Returns an error message, or null when everything checks out. */
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

/** GET /api/promotions — the tenant's promotion rules, newest first. */
export async function GET() {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const [promotions, exclusions] = await Promise.all([
    db.promotion.findMany({
      where: { tenantId: ctx.local.tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        scopeVariants: { include: { variant: { select: { id: true, sku: true, name: true } } } },
        scopeGroups: { include: { subGroup: { include: { group: { select: { name: true } } } } } },
      },
    }),
    db.promotionExclusion.findMany({
      where: { tenantId: ctx.local.tenantId },
      select: { promotionId: true, excludedPromotionId: true },
    }),
  ]);

  // Exclusions are stored as one normalized row per undirected pair (see
  // syncPromotionExclusions); expand back out to "every other id this
  // promotion is excluded from" for each side of the pair.
  const exclusionsByPromotionId = new Map<string, string[]>();
  for (const ex of exclusions) {
    exclusionsByPromotionId.set(ex.promotionId, [
      ...(exclusionsByPromotionId.get(ex.promotionId) ?? []),
      ex.excludedPromotionId,
    ]);
    exclusionsByPromotionId.set(ex.excludedPromotionId, [
      ...(exclusionsByPromotionId.get(ex.excludedPromotionId) ?? []),
      ex.promotionId,
    ]);
  }

  return NextResponse.json({
    promotions: promotions.map((p) => ({
      ...p,
      excludedPromotionIds: exclusionsByPromotionId.get(p.id) ?? [],
    })),
  });
}

/** POST /api/promotions — create a promotion rule and publish
 * `promotion.updated` so Grit POS picks it up. */
export async function POST(request: NextRequest) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

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

  const exclusionError = await validateExclusionOwnership(ctx.local.tenantId, null, data.excludedPromotionIds);
  if (exclusionError) return apiError(exclusionError, 404);

  // Dedupe scope variants by variantId (last one supplied wins) so a
  // duplicate pick in the UI can't create two PromotionVariant rows for the
  // same variant.
  const dedupedVariants = Array.from(
    new Map(data.variantIds.map((v) => [v.variantId, v.requiredQuantity])).entries()
  );

  const promotion = await db.$transaction(async (tx) => {
    const created = await tx.promotion.create({
      data: {
        tenantId: ctx.local.tenantId,
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
    await syncPromotionExclusions(tx, ctx.local.tenantId, created.id, data.excludedPromotionIds);
    return created;
  });

  const scoped = await fetchPromotionScopeById(promotion.id);
  await publishPromotionUpdate(ctx.local.tenantId, scoped, { deleted: false });

  return NextResponse.json({ promotion: scoped }, { status: 201 });
}
