# Grit BizSuite — Milestone Handoff: WMS + Promotions + Pricing Epic

**Prepared for:** whoever (human or AI session) picks up work on this repo next
**Document type:** Milestone handoff
**Branch:** `claude/grit-bizsuite-monorepo-spec-0ol8qo` (repo `GRITui/horeca-pos`, the monorepo root)
**Date:** 2026-07-19
**Status:** Waves 0–2 shipped and pushed. Wave 3 (test coverage) and several P1/P2 items open — see status tables below.

---

## Overview

This document hands off the state of the **Grit BizSuite monorepo** after a
large, multi-session epic: merging four separate apps into one npm-workspaces
monorepo, then building a warehouse-management (picking/packing/labels/
locations/groups) module and a promotions/pricing engine on top, then clearing
a backlog of gaps that build surfaced (VAT-inclusive pricing, discount-
stacking policy, dashboard bugs, persona gaps, etc.) via a tiered multi-agent
orchestration process.

**What this document is:** a snapshot of what's built, how it's built, what's
known-broken or deliberately deferred, and what a reasonable next pass looks
like.

**What this document is NOT:** a replacement for `BACKLOG.md` (the living,
line-level backlog — read that for exact file:line references and full design
write-ups) or `AGENTS.md` (the standing architecture/process rules). Treat
this doc as the narrative on top of those two.

---

## Architecture recap (for anyone unfamiliar with this repo)

- **Structure:** `apps/grit-pos` (Next.js 16 + Prisma 7, checkout), `apps/grit-inventory`
  (Next.js 16 + Prisma 7, multi-location stock/WMS), `apps/grit-taskboard`
  (no-build plain-JS PWA, ops kanban), `apps/grit-reports` (static vanilla-JS,
  cross-app analytics). Each app deploys standalone with its own `package.json`.
- **Cross-app integration is event-only.** `packages/shared-events` defines
  HMAC-signed webhook envelopes + a Postgres outbox (`event_outbox`). Apps
  **never** query each other's databases directly — this is a hard rule, not
  a convention (see `AGENTS.md`).
- **grit-pos is offline-first.** It never calls another app live at checkout;
  it caches whatever it needs (promotion rules, discount policy) locally via
  inbound webhooks, and syncs sales out via `transaction.completed`.
- **Orchestration process** (see `AGENTS.md` "AI orchestration convention"):
  3-layer — Architect (main loop: decomposition, specs, integration
  decisions, final review, commits) → Builders/QC (Sonnet: scoped
  implementation, self-verifying) → Mechanical sweeps (Haiku: lint/doc
  fixes). This session added a fourth tier for money-critical work: an Opus
  adversarial review gate before shipping pricing/discount logic (see Wave 2
  below) — it found a real bug.
- **Coordination artifact:** an architect-maintained "handshake" ledger
  (session-local, not committed — it's coordination metadata, not a product
  artifact) tracked file ownership per wave/squad to prevent two concurrent
  agents from touching the same path. Every wave in this epic was file-
  collision-free by construction, not by luck.

---

## What shipped, by wave

### Pre-existing epic (prior sessions, already on `main`/this branch before this handoff)
Full WMS module (item groups/sub-groups, planogram locations, picking +
packing with barcode-scanner UI, parcel labels) and the promotions engine
(buy-X-pay-Y, buy-X-get-discount, bundle deals) with cross-app sync into
grit-pos's checkout pricing. Desktop-first responsive UI pass across all four
apps. Local dev environment (Postgres + Prisma adapter fallback + no-build
dev shim) with a seeded "Grit Trading Co." demo tenant, live-verified via
Playwright. See commits `d9386d0` through `727adc3`.

### Wave 0 — direct architect fixes
- Fixed `apps/grit-taskboard/tests/test-stripe-webhook.mjs`: it hardcoded a
  deep relative import into `node_modules/stripe/...` that only resolves
  when the package is installed locally, not hoisted by npm workspaces.
  Switched to a bare specifier. `4 passed, 0 failed` now.
- Commit: `fb7c845`.

### Wave 1 — five parallel squads (disjoint files, no shared-file conflicts)
| Squad | Delivered | Outcome |
|---|---|---|
| Dashboard audit | Checked every `/admin/dashboard` stat card (Open orders, Deliveries in flight, Active products) for the same aggregate-masking bug found on Low Stock | All three are correctly tenant-wide (real per-store row counts, not a maintained aggregate) — **no change needed**, reasoning documented |
| Taskboard persona | New "Trading / wholesale company" onboarding persona | Onboarding picker, Settings dropdown, i18n en/th, seed services, demo data, persona-tracker visibility fix |
| WMS hardening | ADMIN gate on pick/pack/label routes + `VariantLocation.isPrimary` DB constraint | **ADMIN gate was reverted on review** — see Known Gaps / Risks below. DB constraint (partial unique index) shipped |
| Reports COGS series | `/api/reports/cogs` now returns a continuous per-day series, not just a period total | Wired into `grit-reports`' margin chart (COGS bars + margin line) |
| SKU-matching scoping doc | Research-only design doc for the POS synthetic-SKU-fallback gap | Added to `BACKLOG.md` under P1 — **no code**, feeds a future dedicated pass |

Commit: `cfa1357`. One real defect caught in review before merge (see below).

### Wave 2 — sequential 3-stage pricing chain + adversarial gate
1. **VAT-inclusive pricing** (grit-pos): `Tenant.vatRate` (configurable, not
   hardcoded), `Variant.vatApplicable` per-SKU exempt flag,
   `computeOrderVat()` deriving `subtotalExclVat`/`vatAmount`/
   `vatExemptSubtotal` at read time, real `tax_amount` on
   `transaction.completed` (was hardcoded `0`), receipt/cart UI breakdown.
2. **Discount-stacking policy publisher** (grit-inventory): `Tenant.discountStackingPolicy`
   (`NO_STACKING` default | `STACK_ALL`), `PromotionExclusion` join table,
   admin UI (policy panel + per-promotion "cannot combine with" picker), new
   `discount_policy.updated` event + `promotion.updated`'s new
   `excluded_promotion_ids` field.
3. **Discount-stacking policy consumer** (grit-pos): `evaluatePromotions()`
   gained a resolution step (stacking, then exclusion) before summing the
   discount; offline-sync's quick-sale path updated to resolve against the
   same policy as the interactive tender path.
4. **Opus adversarial review** of the combined diff — see below.

Event contract addition (`discount_policy.updated`, `promotion.updated.excluded_promotion_ids`)
was done directly by the architect layer, not delegated — `packages/shared-events`
is cross-cutting per `AGENTS.md`.

Commit: `20a3b6f` (contract addition: `ded781b`).

---

## Bugs caught in review (both real, both fixed before merge)

1. **Wave 1 — ADMIN-gate regression.** A squad added `ADMIN`-only gating to
   the pick/pack/label *scan* endpoints, copying the pattern from
   groups/locations/promotions admin routes. On review this was wrong: scan
   endpoints are the actual barcode-scanning operational steps floor staff
   use, not admin config — the epic's own original spec says "let staff use
   scanner to scan barcode when picking and packaging." Gating them would
   have locked ordinary staff out of the workflow entirely. **Reverted**;
   documented in `BACKLOG.md` as still an open product decision if a real
   access-control need ever arises.
2. **Wave 2 — NO_STACKING double-count bug.** The discount-stacking
   resolver picked a per-SKU winning rule but then kept that rule's *entire*
   discount amount (including SKUs it didn't win), so two multi-SKU rules
   (e.g. a bundle deal and a quantity discount) sharing one SKU could both
   survive and double-discount it — exactly what `NO_STACKING` exists to
   prevent. Caught by the Opus adversarial review with a concrete numeric
   failure scenario. **Fixed**: rewrote the resolver as union-find over
   shared SKUs — rules sharing any SKU are grouped into one conflict
   component, only the single highest-amount rule per component survives.
   This guarantees no two surviving rules can ever share a SKU, so no SKU
   can ever be double-discounted, regardless of overlap shape. Verified via
   `tsc` and a manual trace against the reviewer's exact scenario.

A recurring **process gap** also surfaced twice (Wave 1's WMS DB constraint,
Wave 2's VAT/discount-policy migrations): builder agents verified migrations
against **disposable scratch databases**, never the session's actual
persistent seeded dev DBs (`grit_inventory`, `grit_pos`). Both times the
architect layer reconciled this after the fact — checked for pre-existing
data conflicts, applied the migration to the real DB, recorded it in
Prisma's migration ledger. **If you dispatch another wave that touches
schema, budget an explicit reconciliation step** — don't assume a builder's
"migration applied cleanly" claim covers the DB anything else in the session
actually points at.

---

## Backlog status

### P0 — real gaps

| Item | Status |
|---|---|
| Discount resolution policy (stacking + exclusions) | **Shipped** (Wave 2), bug-fixed post-review |
| VAT-inclusive pricing | **Shipped** (Wave 2) |
| No automated tests for WMS/promotions modules | **Open** — `apps/grit-inventory` has no test framework at all; this is the next recommended pass (see below) |
| Dashboard stat cards beyond Low Stock not audited | **Closed, no bug found** (Wave 1) |
| Taskboard stripe-webhook test can't run | **Fixed** (Wave 0) |

### P1 — documented design decisions

| Item | Status |
|---|---|
| Full SSO still a bridge, not real | **Deferred** — architect judgment: high effort/risk, low actual unlock value (apps deliberately keep separate DBs regardless of session unification); no other backlog item depends on it |
| POS synthetic SKU fallback / Inventory matching | **Scoped, not built** — full design doc with 3 candidate approaches added to `BACKLOG.md` (Wave 1); real fix is a shared-catalog epic needing its own dedicated pass |
| No Location model in POS | **Open**, low urgency, documented |
| Parcel labels decorative, not scannable | **Open**, low urgency, documented |
| Pick/pack/label mutations have no ADMIN gate | **Resolved as "intentionally ungated"** after the Wave 1 revert — see Bugs Caught above |
| Reports daily margin/COGS breakdown was null | **Shipped** (Wave 1) |
| Taskboard persona onboarding missing "trading company" | **Shipped** (Wave 1) |

### P2 — smaller / longer-tail

| Item | Status |
|---|---|
| `VariantLocation.isPrimary` no DB constraint | **Shipped** (Wave 1) |
| `Bundle`/`BundleComponent` stub unused | **Open**, not urgent |
| No public storefront/courier/ML forecasting | **Explicitly out of scope**, do not schedule |
| Turbopack can't resolve shared-package specifiers (webpack pinned) | **Open**, not urgent, mechanical fix when someone has spare cycles |

---

## Recommended next steps

1. **Wave 3 — automated test coverage for WMS/promotions.** This is the
   last open P0. `apps/grit-inventory` currently has zero test framework
   (ad-hoc verification scripts only) — this is a bigger lift than Waves 1–2
   because it starts with "pick and wire up a test framework," not just
   "write tests." Recommend scoping this as its own dedicated pass rather
   than another 5-squad parallel wave: pick the framework first (architect
   decision), then parallelize test-writing by module (groups/locations,
   picking/packing, labels, promotions) once the harness exists. Should
   target the **post-Wave-2 shape** of `evaluatePromotions` (with stacking
   + exclusion resolution), not the pre-Wave-2 behavior.
2. **POS ↔ Inventory SKU alignment.** The scoping doc in `BACKLOG.md` (P1)
   is ready for someone to pick a direction from its 3 candidate approaches
   and turn it into a dedicated build pass — it's flagged as too large for
   a single blind builder task.
3. **Turbopack cleanup** (P2) is cheap, mechanical, and safe to hand to a
   Haiku-tier sweep whenever convenient — extensionless imports in
   `packages/*` need explicit `.js` extensions.
4. Everything else in the P1/P2 tables above is either genuinely deferred
   (SSO) or low-urgency enough to leave as documented debt.

---

## Risks / open questions to flag explicitly

- **Local dev DB drift.** This sandbox has real seeded data in `grit_inventory`
  and `grit_pos` (a "Grit Trading Co." demo tenant used for live
  verification throughout the epic). If this session's container is
  discarded, that data goes with it — nothing about the demo tenant itself
  is committed to git (by design; it's runtime data). A fresh environment
  will need to re-seed before any live/Playwright verification is possible
  again.
- **Migration checksums were hand-computed** for the reconciliation steps
  described above (SHA-256 of each `migration.sql`, inserted directly into
  `_prisma_migrations`) rather than run through `prisma migrate deploy`
  against the real DB, because several of these apps' earliest migrations
  can't replay against an empty shadow database (pre-existing condition,
  documented per-stage in the build reports, not something this epic
  introduced). This is consistent with the existing repo convention but is
  worth knowing before assuming `prisma migrate status` alone tells the
  full story.
- **Exact `NO_STACKING` semantics are conservative, not maximal.** The
  union-find fix guarantees zero double-counting but will sometimes drop a
  rule that could theoretically have partially applied (see the code
  comment in `apps/grit-pos/lib/promotions.ts`'s `resolveStacking`) — this
  was a deliberate tradeoff (correctness over maximal-discount cleverness)
  given the file's `evaluate*` functions don't return per-SKU breakdowns.
  If per-SKU attribution ever becomes a real product ask, it requires
  refactoring `evaluateBuyXPayY`/`evaluateBuyXGetDiscount`/`evaluateBundleDeal`
  to return per-SKU discount maps, not just a fix to the resolver.

---

## Appendix

**Key commits this handoff covers:**
| Commit | What |
|---|---|
| `fb7c845` | Wave 0: stripe test fix |
| `ded781b` | Event contract: `discount_policy.updated` + exclusion field |
| `cfa1357` | Wave 1: 5 squads (dashboard, persona, WMS hardening, reports, SKU doc) |
| `20a3b6f` | Wave 2: VAT pricing + discount-stacking policy, incl. the union-find fix |

**Key files for whoever picks this up next:**
- `BACKLOG.md` — the living backlog, line-level detail on every open item
- `AGENTS.md` — architecture rules + orchestration convention
- `apps/grit-pos/lib/promotions.ts` — checkout-time discount evaluation
  (`evaluatePromotions`, `resolveStacking`, `resolveExclusions`)
- `apps/grit-pos/app/api/orders/_lib/queries.ts` — `OrderDTO`,
  `computeOrderDiscount`, `computeOrderVat`
- `apps/grit-inventory/src/components/promotions-manager.tsx` — promotions
  admin UI, including the new discount-policy panel and exclusion picker
- `packages/shared-events/src/contracts.ts` — the full event catalogue
