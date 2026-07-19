import type { DiscountPolicyUpdatedData, PromotionUpdatedData } from "@grit/shared-events/contracts";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { publishDiscountPolicyUpdated, publishPromotionUpdated } from "@/lib/events";
import { formatCurrency } from "@/lib/format";

type TxClient = Prisma.TransactionClient;

/**
 * Grit BizSuite pivot: pricing/promotion rules admin support. Source of
 * truth lives here (alongside product/group master data); every
 * create/update/deactivate/delete pushes the current rule set to Grit POS
 * via the `promotion.updated` event so checkout can apply it without a live
 * cross-app call (POS is offline-first — see the Promotion model's schema
 * comment and PromotionUpdatedData's docstring in
 * @grit/shared-events/contracts).
 */

/** Shape returned by `fetchPromotionWithScope` — includes everything needed
 * to render a summary and resolve the event's `items` array. */
export type PromotionWithScope = Awaited<ReturnType<typeof fetchPromotionWithScope>>;

const SCOPE_INCLUDE = {
  scopeVariants: {
    include: { variant: { select: { id: true, sku: true, name: true } } },
  },
  scopeGroups: {
    include: {
      subGroup: {
        include: {
          products: {
            include: { variants: { select: { sku: true } } },
          },
        },
      },
    },
  },
} as const;

/** Fetch a tenant-scoped promotion with everything needed to summarize it
 * and resolve its event payload. Returns null when not found. */
export async function fetchPromotionWithScope(id: string, tenantId: string) {
  return db.promotion.findFirst({
    where: { id, tenantId },
    include: SCOPE_INCLUDE,
  });
}

/** Same shape, keyed by promotionId only (used right after a create/update
 * inside the same request, where tenant ownership is already established). */
export async function fetchPromotionScopeById(id: string) {
  return db.promotion.findUniqueOrThrow({
    where: { id },
    include: SCOPE_INCLUDE,
  });
}

/**
 * Discount resolution policy (BACKLOG.md), layer 2 — per-order exclusion
 * rules. An exclusion is an undirected pair, but the schema's
 * `PromotionExclusion` table stores it as two ordered columns
 * (`promotionId`, `excludedPromotionId`) with a `@@unique` on the pair, so
 * A-excludes-B and B-excludes-A must be normalized to the same row rather
 * than allowed to collide as two rows. This always orders the pair by
 * plain string comparison — callers never need to know or care which side
 * of the pair a given id ends up on.
 */
export function normalizeExclusionPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Every other promotion id `promotionId` is currently excluded from
 * combining with, resolved from either side of the normalized pair. */
export async function fetchExcludedPromotionIds(promotionId: string): Promise<string[]> {
  const rows = await db.promotionExclusion.findMany({
    where: { OR: [{ promotionId }, { excludedPromotionId: promotionId }] },
    select: { promotionId: true, excludedPromotionId: true },
  });
  return rows.map((r) => (r.promotionId === promotionId ? r.excludedPromotionId : r.promotionId));
}

/** Confirms every id in `excludedPromotionIds` is a real promotion owned by
 * `tenantId`, and that a rule doesn't try to exclude itself. Returns an
 * error message, or null when everything checks out. */
export async function validateExclusionOwnership(
  tenantId: string,
  promotionId: string | null,
  excludedPromotionIds: string[]
): Promise<string | null> {
  if (excludedPromotionIds.length === 0) return null;
  if (promotionId && excludedPromotionIds.includes(promotionId)) {
    return "A promotion cannot be excluded from combining with itself";
  }
  const uniqueIds = Array.from(new Set(excludedPromotionIds));
  const count = await db.promotion.count({ where: { id: { in: uniqueIds }, tenantId } });
  if (count !== uniqueIds.length) return "One or more excluded promotions not found";
  return null;
}

/**
 * Full-replace sync of `promotionId`'s exclusion set to `desiredOtherIds`
 * (must run inside the same transaction as the promotion's other scope
 * writes, same delete-then-recreate pattern as scopeVariants/scopeGroups
 * in the API routes). Deletes every existing row touching `promotionId`
 * from either side of the pair, then re-inserts one normalized row per
 * desired partner.
 */
export async function syncPromotionExclusions(
  tx: TxClient,
  tenantId: string,
  promotionId: string,
  desiredOtherIds: string[]
): Promise<void> {
  await tx.promotionExclusion.deleteMany({
    where: { OR: [{ promotionId }, { excludedPromotionId: promotionId }] },
  });

  const uniqueOtherIds = Array.from(new Set(desiredOtherIds)).filter((id) => id !== promotionId);
  if (uniqueOtherIds.length === 0) return;

  const pairs = new Map<string, [string, string]>();
  for (const otherId of uniqueOtherIds) {
    const pair = normalizeExclusionPair(promotionId, otherId);
    pairs.set(pair.join(":"), pair);
  }

  await tx.promotionExclusion.createMany({
    data: Array.from(pairs.values()).map(([primaryId, secondaryId]) => ({
      tenantId,
      promotionId: primaryId,
      excludedPromotionId: secondaryId,
    })),
  });
}

type ScopedPromotion = NonNullable<Awaited<ReturnType<typeof fetchPromotionWithScope>>>;

/**
 * Resolves the SKUs a rule applies to: `scopeVariants` directly, plus
 * `scopeGroups` expanded to every product's variants currently in that
 * sub-group (bundle_deal never uses scopeGroups per the schema design, so
 * this is a no-op for that type). Explicit `scopeVariants.requiredQuantity`
 * wins over the group expansion's default of 1 when a SKU appears in both.
 */
export function resolvePromotionItems(
  promo: Pick<ScopedPromotion, "scopeVariants" | "scopeGroups">
): PromotionUpdatedData["items"] {
  const bySku = new Map<string, number>();

  for (const scopeGroup of promo.scopeGroups) {
    for (const product of scopeGroup.subGroup.products) {
      for (const variant of product.variants) {
        if (!bySku.has(variant.sku)) bySku.set(variant.sku, 1);
      }
    }
  }

  for (const scopeVariant of promo.scopeVariants) {
    bySku.set(scopeVariant.variant.sku, scopeVariant.requiredQuantity);
  }

  return Array.from(bySku.entries()).map(([sku, required_quantity]) => ({
    sku,
    required_quantity,
  }));
}

/** Human-readable one-liner per PromotionType, used in the admin list. */
export function promotionSummary(
  promo: Pick<
    ScopedPromotion,
    "type" | "buyQuantity" | "payQuantity" | "minQuantity" | "discountKind" | "discountValue" | "bundlePrice" | "scopeVariants"
  >
): string {
  switch (promo.type) {
    case "buy_x_pay_y":
      return `Buy ${promo.buyQuantity} pay for ${promo.payQuantity}`;
    case "buy_x_get_discount": {
      const value = Number(promo.discountValue ?? 0);
      const discount = promo.discountKind === "percent" ? `${value}% off` : `${formatCurrency(value)} off`;
      return `Buy ${promo.minQuantity}+ get ${discount}`;
    }
    case "bundle_deal": {
      const totalQty = promo.scopeVariants.reduce((sum, v) => sum + v.requiredQuantity, 0);
      return `Bundle: ${formatCurrency(Number(promo.bundlePrice ?? 0))} for ${totalQty} item${totalQty === 1 ? "" : "s"}`;
    }
    default:
      return promo.type;
  }
}

/**
 * Builds and fire-and-forget publishes the `promotion.updated` event for a
 * promotion. `deleted` should be true for an explicit DELETE, or whenever
 * the resulting `isActive` is false — per the event contract's docstring,
 * both mean "stop applying this rule" from POS's perspective, so a
 * deactivate carries the same `deleted: true` signal as a hard delete.
 * Never throws — publish failures must never break the CRUD operation that
 * triggered them (see `publishEventSafe` in lib/events.ts).
 */
export async function publishPromotionUpdate(
  tenantId: string,
  promo: Pick<
    ScopedPromotion,
    | "id"
    | "name"
    | "type"
    | "isActive"
    | "startsAt"
    | "endsAt"
    | "buyQuantity"
    | "payQuantity"
    | "minQuantity"
    | "discountKind"
    | "discountValue"
    | "bundlePrice"
    | "scopeVariants"
    | "scopeGroups"
  >,
  options: { deleted: boolean }
): Promise<void> {
  const deleted = options.deleted || !promo.isActive;
  // A deleted/deactivated rule's exclusions are moot from POS's perspective
  // (there's nothing left to exclude anything from), and — for a hard
  // DELETE specifically — the rows are already gone by the time this runs
  // (PromotionExclusion cascades on Promotion delete), so skip the lookup.
  const excludedPromotionIds = deleted ? [] : await fetchExcludedPromotionIds(promo.id).catch((err) => {
    console.warn(`[promotions] exclusion lookup failed for ${promo.id}:`, err);
    return [] as string[];
  });
  const data: PromotionUpdatedData = {
    promotion_id: promo.id,
    name: promo.name,
    type: promo.type,
    is_active: promo.isActive,
    deleted,
    starts_at: promo.startsAt ? promo.startsAt.toISOString() : null,
    ends_at: promo.endsAt ? promo.endsAt.toISOString() : null,
    ...(promo.buyQuantity != null ? { buy_quantity: promo.buyQuantity } : {}),
    ...(promo.payQuantity != null ? { pay_quantity: promo.payQuantity } : {}),
    ...(promo.minQuantity != null ? { min_quantity: promo.minQuantity } : {}),
    ...(promo.discountKind != null ? { discount_kind: promo.discountKind } : {}),
    ...(promo.discountValue != null ? { discount_value: Number(promo.discountValue) } : {}),
    ...(promo.bundlePrice != null ? { bundle_price: Number(promo.bundlePrice) } : {}),
    items: resolvePromotionItems(promo),
    ...(excludedPromotionIds.length > 0 ? { excluded_promotion_ids: excludedPromotionIds } : {}),
  };

  try {
    await publishPromotionUpdated(tenantId, data);
  } catch (err) {
    // publishPromotionUpdated already swallows publish errors internally
    // (publishEventSafe); this belt-and-suspenders catch guarantees a bug in
    // event construction itself can never surface as a failed CRUD request.
    console.warn(`[promotions] event publish failed for ${promo.id}:`, err);
  }
}

/**
 * Publishes `discount_policy.updated` for the tenant's current
 * `discountStackingPolicy` setting. Called whenever that setting is saved
 * (see api/tenant-settings/route.ts) so Grit POS's offline-first cache
 * stays in sync — same reasoning as `publishPromotionUpdate` above.
 */
export async function publishDiscountPolicyUpdate(
  tenantId: string,
  policy: DiscountPolicyUpdatedData["policy"]
): Promise<void> {
  try {
    await publishDiscountPolicyUpdated(tenantId, { policy });
  } catch (err) {
    console.warn(`[promotions] discount policy publish failed for tenant ${tenantId}:`, err);
  }
}
