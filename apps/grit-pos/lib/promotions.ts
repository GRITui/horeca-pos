import "server-only";

import type { PromotionRule } from "@/app/generated/prisma/client";

// ---------------------------------------------------------------------------
// Checkout-time promotion evaluation.
//
// Pure function over the locally cached `PromotionRule` rows (synced by the
// inbound `promotion.updated` webhook, app/api/events/grit/route.ts) and the
// cart's current lines. Never calls another app — grit-pos is offline-first
// and this is the only pricing logic that runs at checkout time.
//
// Discounts are surfaced as a distinct order-total adjustment (a "Discounts"
// line), never by mutating OrderLine.unitPrice — the original line pricing
// stays intact for audit (see app/api/orders/_lib/queries.ts).
//
// Discount resolution (BACKLOG.md "Discount resolution policy (configurable
// per tenant)"): every currently-active rule that matches the cart is
// evaluated first, then resolved down to the set that actually applies,
// in two steps — see `resolveStacking`/`resolveExclusions` below:
//   1. Stacking policy (tenant-wide, synced via `discount_policy.updated` —
//      Tenant.discountStackingPolicy): NO_STACKING keeps only the single
//      best-discount rule per line/SKU; STACK_ALL keeps every match.
//   2. Pairwise exclusion (always on, regardless of policy): a rule synced
//      with `excludedRuleIds` (from `promotion.updated`'s
//      excluded_promotion_ids) is dropped if another still-kept rule
//      excludes it, or vice versa.
// ---------------------------------------------------------------------------

export interface PromotionCartLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface AppliedPromotion {
  ruleId: string;
  name: string;
  amount: number;
}

export interface PromotionEvaluation {
  /** Total discount across every rule that applied (post-resolution), rounded to cents. */
  totalDiscount: number;
  applied: AppliedPromotion[];
}

/** Tenant-wide discount-stacking policy — mirrors Tenant.discountStackingPolicy / DiscountPolicyUpdatedData.policy. */
export type DiscountStackingPolicy = "NO_STACKING" | "STACK_ALL";

/**
 * Tenant.discountStackingPolicy is a plain synced String column (same
 * "opaque cross-app pivot field" convention as Tenant.tier), so callers
 * reading it out of Prisma get `string`, not the narrowed union. Normalize
 * here rather than at each call site; falls back to NO_STACKING (the safer,
 * schema-default behavior) for anything unrecognized rather than silently
 * stacking every rule.
 */
export function normalizeStackingPolicy(raw: string): DiscountStackingPolicy {
  return raw === "STACK_ALL" ? "STACK_ALL" : "NO_STACKING";
}

/** One entry of a PromotionRule.items JSON array (mirrors PromotionUpdatedData.items — snake_case, a cache of the wire payload). */
interface PromotionRuleItem {
  sku: string;
  required_quantity: number;
}

/** A rule's computed discount before stacking/exclusion resolution, carrying what the resolution step needs (the SKUs it touches, and its own exclusion list) alongside the public AppliedPromotion fields. */
interface ResolvableApplication extends AppliedPromotion {
  skus: string[];
  excludedRuleIds: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseItems(raw: unknown): PromotionRuleItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((it): it is PromotionRuleItem =>
    isRecord(it) &&
    typeof it.sku === "string" &&
    it.sku.length > 0 &&
    typeof it.required_quantity === "number" &&
    Number.isFinite(it.required_quantity) &&
    it.required_quantity > 0,
  );
}

/** Parses PromotionRule.excludedRuleIds (array of PromotionRule ids, mirrors PromotionUpdatedData.excluded_promotion_ids). */
function parseExcludedRuleIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Rounds to the nearest cent — money math here is plain `number` (matching OrderDTO's shape), not Decimal. */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRuleCurrentlyActive(rule: PromotionRule, now: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.startsAt && now < rule.startsAt) return false;
  if (rule.endsAt && now > rule.endsAt) return false;
  return true;
}

/**
 * Evaluates every currently-active rule in `activeRules` against `lines`
 * (keyed by SKU — see `eventItemSku` in lib/events.ts for how a line's SKU is
 * resolved), resolves the result against `stackingPolicy` and each rule's
 * synced exclusion set (see the file-level doc comment), and returns the
 * resolved total discount plus a per-rule breakdown.
 *
 * Rules are filtered here (isActive + startsAt/endsAt window) rather than
 * trusted from the caller's query, so this stays correct even if the caller
 * passes an unfiltered set.
 */
export function evaluatePromotions(
  lines: PromotionCartLine[],
  activeRules: PromotionRule[],
  stackingPolicy: DiscountStackingPolicy,
): PromotionEvaluation {
  const now = new Date();
  const quantityBySku = new Map<string, number>();
  const unitPriceBySku = new Map<string, number>();
  for (const line of lines) {
    quantityBySku.set(line.sku, (quantityBySku.get(line.sku) ?? 0) + line.quantity);
    // Multiple lines can share a SKU (e.g. same product added twice); keep
    // the first unit price seen — line-splitting on the same SKU at
    // different prices isn't a case this app produces today.
    if (!unitPriceBySku.has(line.sku)) unitPriceBySku.set(line.sku, line.unitPrice);
  }

  // Deterministic processing order regardless of the DB row order the caller
  // fetched `activeRules` in (its `findMany` carries no `orderBy`) — both
  // `resolveStacking`'s tiebreak and `resolveExclusions`' "drop the later
  // one" rule depend on a stable order.
  const sortedRules = [...activeRules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const computed: ResolvableApplication[] = [];

  for (const rule of sortedRules) {
    if (!isRuleCurrentlyActive(rule, now)) continue;

    const items = parseItems(rule.items);
    let ruleDiscount = 0;

    switch (rule.type) {
      case "buy_x_pay_y": {
        ruleDiscount = evaluateBuyXPayY(rule, items, quantityBySku, unitPriceBySku);
        break;
      }
      case "buy_x_get_discount": {
        ruleDiscount = evaluateBuyXGetDiscount(rule, items, quantityBySku, unitPriceBySku);
        break;
      }
      case "bundle_deal": {
        ruleDiscount = evaluateBundleDeal(rule, items, quantityBySku, unitPriceBySku);
        break;
      }
      default:
        // Unknown/future rule type cached locally — ignore rather than throw,
        // so an inventory-side addition never breaks checkout here.
        break;
    }

    if (ruleDiscount > 0) {
      computed.push({
        ruleId: rule.id,
        name: rule.name,
        amount: roundCents(ruleDiscount),
        skus: items.map((item) => item.sku),
        excludedRuleIds: parseExcludedRuleIds(rule.excludedRuleIds),
      });
    }
  }

  const stacked = resolveStacking(computed, stackingPolicy);
  const resolved = resolveExclusions(stacked);

  let totalDiscount = 0;
  const applied: AppliedPromotion[] = resolved.map(({ ruleId, name, amount }) => {
    totalDiscount += amount;
    return { ruleId, name, amount };
  });

  return { totalDiscount: roundCents(totalDiscount), applied };
}

/**
 * Step 1 of resolution: the tenant's stacking policy.
 *
 * STACK_ALL: no-op — every computed discount survives (today's behavior).
 *
 * NO_STACKING: a rule's discount `amount` is a single number covering every
 * SKU it touches (the evaluate* functions don't return a per-SKU
 * breakdown), so a naive "best rule per SKU" pick is unsafe for multi-SKU
 * rules (bundle_deal, or a buy_x_get_discount scoped to several SKUs) —
 * keeping a rule because it won on SKU A but not SKU B still adds its whole
 * amount, double-discounting SKU B if a different rule also won there.
 *
 * Instead: any two rules that share at least one SKU are transitively
 * grouped into one conflict component (union-find over `skus`), and only
 * the single highest-amount rule survives per component (ties broken by
 * ascending `ruleId`). This guarantees no two surviving rules ever share a
 * SKU, so no SKU can ever be double-discounted — the actual invariant
 * NO_STACKING exists to protect, even at the cost of being conservative
 * about which single rule "should" win when a multi-SKU rule only partially
 * beats another. Rules that share no SKU with anything else survive as
 * trivial single-rule components.
 */
function resolveStacking(
  computed: ResolvableApplication[],
  policy: DiscountStackingPolicy,
): ResolvableApplication[] {
  if (policy !== "NO_STACKING") return computed;

  // Union-find over rule indices, merging any two rules that share a SKU.
  const parent = computed.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const indicesBySku = new Map<string, number[]>();
  computed.forEach((entry, i) => {
    for (const sku of entry.skus) {
      const list = indicesBySku.get(sku);
      if (list) list.push(i);
      else indicesBySku.set(sku, [i]);
    }
  });
  for (const indices of indicesBySku.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  const bestByComponent = new Map<number, number>(); // component root -> winning index
  computed.forEach((entry, i) => {
    const root = find(i);
    const currentBest = bestByComponent.get(root);
    if (
      currentBest === undefined ||
      entry.amount > computed[currentBest].amount ||
      (entry.amount === computed[currentBest].amount && entry.ruleId < computed[currentBest].ruleId)
    ) {
      bestByComponent.set(root, i);
    }
  });

  const winningIndices = new Set(bestByComponent.values());
  return computed.filter((_, i) => winningIndices.has(i));
}

/**
 * Step 2 of resolution: pairwise exclusion (`excludedRuleIds`), applied
 * AFTER stacking and independent of the policy above. Checked
 * order-independently between any two still-kept entries — either side
 * listing the other in its `excludedRuleIds` is enough — but the *drop* is
 * deterministic: entries are walked in their already-stable order, and for
 * any mutually-exclusive pair still standing, the later one in that order is
 * the one dropped, never both.
 */
function resolveExclusions(entries: ResolvableApplication[]): ResolvableApplication[] {
  const dropped = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    if (dropped.has(entries[i].ruleId)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (dropped.has(entries[j].ruleId)) continue;
      const earlier = entries[i];
      const later = entries[j];
      if (
        earlier.excludedRuleIds.includes(later.ruleId) ||
        later.excludedRuleIds.includes(earlier.ruleId)
      ) {
        dropped.add(later.ruleId);
      }
    }
  }
  return entries.filter((entry) => !dropped.has(entry.ruleId));
}

/** buy_x_pay_y: floor(Q / buyQuantity) complete groups, each giving away (buyQuantity - payQuantity) of the cheapest units — modeled here as that many units at the line's unit price. */
function evaluateBuyXPayY(
  rule: PromotionRule,
  items: PromotionRuleItem[],
  quantityBySku: Map<string, number>,
  unitPriceBySku: Map<string, number>,
): number {
  const buyQuantity = rule.buyQuantity ?? 0;
  const payQuantity = rule.payQuantity ?? 0;
  if (buyQuantity <= 0 || payQuantity < 0 || payQuantity >= buyQuantity) return 0;

  let discount = 0;
  for (const item of items) {
    const quantity = quantityBySku.get(item.sku) ?? 0;
    const unitPrice = unitPriceBySku.get(item.sku);
    if (quantity <= 0 || unitPrice === undefined) continue;

    const groups = Math.floor(quantity / buyQuantity);
    if (groups <= 0) continue;
    discount += groups * (buyQuantity - payQuantity) * unitPrice;
  }
  return discount;
}

/** buy_x_get_discount: cart quantity >= minQuantity unlocks percent-off or fixed-amount-off, capped at that SKU's own subtotal. */
function evaluateBuyXGetDiscount(
  rule: PromotionRule,
  items: PromotionRuleItem[],
  quantityBySku: Map<string, number>,
  unitPriceBySku: Map<string, number>,
): number {
  const minQuantity = rule.minQuantity ?? 0;
  const discountValue = Number(rule.discountValue ?? 0);
  if (discountValue <= 0) return 0;

  let discount = 0;
  for (const item of items) {
    const quantity = quantityBySku.get(item.sku) ?? 0;
    const unitPrice = unitPriceBySku.get(item.sku);
    if (quantity <= 0 || quantity < minQuantity || unitPrice === undefined) continue;

    const lineSubtotal = unitPrice * quantity;
    let lineDiscount = 0;
    if (rule.discountKind === "percent") {
      lineDiscount = (unitPrice * quantity * discountValue) / 100;
    } else if (rule.discountKind === "fixed_amount") {
      lineDiscount = discountValue * quantity;
    }
    discount += Math.min(lineDiscount, lineSubtotal);
  }
  return discount;
}

/** bundle_deal: every required item present at >= its required_quantity unlocks one bundle set at bundlePrice instead of the items' normal combined price; repeats for as many complete sets as the cart holds. */
function evaluateBundleDeal(
  rule: PromotionRule,
  items: PromotionRuleItem[],
  quantityBySku: Map<string, number>,
  unitPriceBySku: Map<string, number>,
): number {
  if (items.length === 0) return 0;
  const bundlePrice = Number(rule.bundlePrice ?? 0);

  let completeSets = Infinity;
  for (const item of items) {
    const quantity = quantityBySku.get(item.sku) ?? 0;
    completeSets = Math.min(completeSets, Math.floor(quantity / item.required_quantity));
    if (completeSets <= 0) return 0;
  }
  if (!Number.isFinite(completeSets) || completeSets <= 0) return 0;

  let normalSetPrice = 0;
  for (const item of items) {
    const unitPrice = unitPriceBySku.get(item.sku);
    if (unitPrice === undefined) return 0; // Shouldn't happen given completeSets > 0 above, but stay defensive.
    normalSetPrice += unitPrice * item.required_quantity;
  }

  const perSetDiscount = normalSetPrice - bundlePrice;
  if (perSetDiscount <= 0) return 0;
  return perSetDiscount * completeSets;
}
