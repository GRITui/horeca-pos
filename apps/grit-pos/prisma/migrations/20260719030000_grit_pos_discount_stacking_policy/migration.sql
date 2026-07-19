-- Discount resolution policy (configurable per tenant) — see BACKLOG.md
-- "Discount resolution policy (configurable per tenant)" > "Sync to POS".
--
-- Grit Inventory's promotion.updated event now carries an
-- `excluded_promotion_ids` array per rule, and a new discount_policy.updated
-- event carries the tenant-wide stacking policy. Both are synced into these
-- two columns by app/api/events/grit/route.ts and consumed by
-- lib/promotions.ts's evaluatePromotions resolution step.
--
-- Additive/idempotent (ADD COLUMN IF NOT EXISTS), matching this app's
-- migration convention (see 20260718120000_grit_pos_pivot's note on why).

-- ---------------------------------------------------------------------------
-- Tenant: synced tenant-wide stacking policy ('NO_STACKING' | 'STACK_ALL').
-- Kept as a plain column on Tenant (not a new table), matching how vatRate
-- just landed here for the same "tenant-level setting synced from an
-- inbound event" shape.
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "discountStackingPolicy" TEXT NOT NULL DEFAULT 'NO_STACKING';

-- ---------------------------------------------------------------------------
-- PromotionRule: synced per-rule exclusion set (array of PromotionRule ids
-- this rule must never co-apply with on the same order), same JSON-array
-- convention as the existing `items` column.
-- ---------------------------------------------------------------------------

ALTER TABLE "promotion_rules"
  ADD COLUMN IF NOT EXISTS "excludedRuleIds" JSONB NOT NULL DEFAULT '[]';
