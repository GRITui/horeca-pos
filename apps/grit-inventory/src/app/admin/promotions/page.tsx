import { redirect } from "next/navigation";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { getGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { PromotionsManager } from "@/components/promotions-manager";

export const dynamic = "force-dynamic";

/**
 * Promotion rules admin (Grit BizSuite pivot). Gated on
 * `inventory.multi_location` (SCALE) — the existing feature key, no new key
 * added, same convention as Groups/Locations/Transfers. Every
 * create/update/deactivate/delete publishes `promotion.updated` so Grit POS
 * (offline-first) can keep its local rule cache in sync — see
 * src/lib/promotions.ts.
 */
export default async function PromotionsPage() {
  const ctx = await getGritContext();
  if (!ctx) redirect("/login");

  if (!hasFeatureAccess(ctx.grit, "inventory.multi_location")) {
    return (
      <div>
        <PageHeader title="Promotions" description="Buy-X-pay-Y, quantity discounts, and bundle deals." />
        <Card>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Promotions are a SCALE feature
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Your current plan ({ctx.grit.tier}) doesn&apos;t include promotion rules. Upgrade to SCALE to
            create buy-X-pay-Y, quantity-discount, and bundle-deal offers that sync to Grit POS.
          </p>
        </Card>
      </div>
    );
  }

  const [promotions, variants, subGroups, exclusions, tenant] = await Promise.all([
    db.promotion.findMany({
      where: { tenantId: ctx.local.tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        scopeVariants: { include: { variant: { select: { id: true, sku: true, name: true } } } },
        scopeGroups: { include: { subGroup: { include: { group: { select: { name: true } } } } } },
      },
    }),
    db.variant.findMany({
      where: { tenantId: ctx.local.tenantId, isActive: true },
      include: { product: { select: { name: true } } },
      orderBy: { sku: "asc" },
    }),
    db.itemSubGroup.findMany({
      where: { tenantId: ctx.local.tenantId },
      include: { group: { select: { name: true } } },
      orderBy: [{ name: "asc" }],
    }),
    db.promotionExclusion.findMany({
      where: { tenantId: ctx.local.tenantId },
      select: { promotionId: true, excludedPromotionId: true },
    }),
    db.tenant.findUniqueOrThrow({
      where: { id: ctx.local.tenantId },
      select: { discountStackingPolicy: true },
    }),
  ]);

  // Exclusions are stored as one normalized row per undirected pair (see
  // syncPromotionExclusions in src/lib/promotions.ts); expand back out to
  // "every other id this promotion is excluded from" for each side.
  const excludedIdsByPromotionId = new Map<string, string[]>();
  for (const ex of exclusions) {
    excludedIdsByPromotionId.set(ex.promotionId, [
      ...(excludedIdsByPromotionId.get(ex.promotionId) ?? []),
      ex.excludedPromotionId,
    ]);
    excludedIdsByPromotionId.set(ex.excludedPromotionId, [
      ...(excludedIdsByPromotionId.get(ex.excludedPromotionId) ?? []),
      ex.promotionId,
    ]);
  }

  return (
    <div>
      <PageHeader
        title="Promotions"
        description="Buy-X-pay-Y, quantity discounts, and bundle deals. Changes push to Grit POS automatically."
      />
      <PromotionsManager
        discountStackingPolicy={tenant.discountStackingPolicy === "STACK_ALL" ? "STACK_ALL" : "NO_STACKING"}
        promotions={promotions.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          isActive: p.isActive,
          startsAt: p.startsAt ? p.startsAt.toISOString() : null,
          endsAt: p.endsAt ? p.endsAt.toISOString() : null,
          buyQuantity: p.buyQuantity,
          payQuantity: p.payQuantity,
          minQuantity: p.minQuantity,
          discountKind: p.discountKind,
          discountValue: p.discountValue ? p.discountValue.toString() : null,
          bundlePrice: p.bundlePrice ? p.bundlePrice.toString() : null,
          scopeVariants: p.scopeVariants.map((sv) => ({
            id: sv.id,
            variantId: sv.variantId,
            requiredQuantity: sv.requiredQuantity,
            sku: sv.variant.sku,
            name: sv.variant.name,
          })),
          scopeGroups: p.scopeGroups.map((sg) => ({
            id: sg.id,
            subGroupId: sg.subGroupId,
            name: sg.subGroup.name,
            groupName: sg.subGroup.group.name,
          })),
          excludedPromotionIds: excludedIdsByPromotionId.get(p.id) ?? [],
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          productName: v.product.name,
        }))}
        subGroups={subGroups.map((sg) => ({
          id: sg.id,
          name: sg.name,
          groupName: sg.group.name,
        }))}
      />
    </div>
  );
}
