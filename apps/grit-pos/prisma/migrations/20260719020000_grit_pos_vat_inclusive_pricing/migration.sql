-- VAT-inclusive pricing (Thailand 7%, per-item exempt flag) — see
-- BACKLOG.md "VAT-inclusive pricing (Thailand 7%, per-item exempt flag)".
--
-- Selling price stays the single source of truth (VAT-inclusive by default);
-- no new stored "excl-VAT price" column. Excl-VAT/VAT amounts are derived at
-- read time from `price` + these two flags — see computeOrderVat in
-- app/api/orders/_lib/queries.ts.
--
-- Additive/idempotent (IF NOT EXISTS), matching this app's migration
-- convention (see 20260718120000_grit_pos_pivot's note on why).

-- ---------------------------------------------------------------------------
-- Tenant: configurable VAT rate (not hardcoded — Thailand's rate is set by
-- periodically-renewed cabinet resolution, and the platform isn't
-- Thailand-only).
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 7.00;

-- ---------------------------------------------------------------------------
-- Variant: per-SKU VAT-exempt opt-out. Defaults true (standard-rated) since
-- most retail goods are VAT-inclusive; staff flip it off per item where the
-- law requires it.
-- ---------------------------------------------------------------------------

ALTER TABLE "variants"
  ADD COLUMN IF NOT EXISTS "vatApplicable" BOOLEAN NOT NULL DEFAULT true;
