# Ecommerce Order-Fulfillment / Inventory / Delivery Platform — Stack & Architecture Handoff

**Prepared for:** Engineering (human or AI coding agent) picking up implementation
**Document type:** Technical handoff — tech stack decision + MVP/Milestone-2 architecture spec
**Status:** Draft for build — v0.1 (decisions confirmed by stakeholder, no code written yet)
**Date:** 2026-07-18

## Overview

This document specifies the recommended technology stack and target data architecture for a new application covering order fulfillment, inventory management, delivery management, re-stock forecasting, and dead-stock analysis. It is the output of an orchestrated multi-angle assessment (4 candidate stacks scored across 5 weighted dimensions) plus a stakeholder sign-off round.

This is **a handoff for implementation planning**, not a finished implementation — no repository exists yet and no code has been written. It defines: which stack to use and why, what Milestone 1 (MVP) must cover, what Milestone 2 ("next ambitious") adds, and the schema-level design needed for the trickiest requirement (build-to-sell bundle items). Open questions that still need answers before certain M2 work can be scoped are called out explicitly in Section 6.

## 1. Decision Summary

| Decision | Choice |
|---|---|
| **Stack** | Next.js (App Router) + TypeScript + React + Prisma ORM + Neon serverless Postgres + Tailwind CSS, deployed as a single app on Vercel, with hand-rolled JWT auth (jose + bcryptjs) |
| **Pattern source** | Directly extends the existing `gritui/horeca-pos` repo's stack and conventions — no new language, runtime, or hosting target for the team |
| **Milestone 1 scope** | **Admin-only ops tool** — staff enter/manage orders; no public customer-facing storefront or checkout |
| **Delivery tracking (M1)** | **In-house, manual status updates** by staff — no third-party courier API/webhook integration |
| **Forecasting (M1)** | **Naive heuristic** (moving-average / seasonal-naive) computed in SQL/TypeScript — no dedicated statistics service |
| **Background jobs** | Vercel Cron hitting API routes (restock alerts, nightly forecast recompute, nightly dead-stock scan) |
| **Testing** | Ad-hoc check-scripts, consistent with team convention (no Jest/Vitest/Playwright introduced) |

## 2. Why This Stack

Four candidates were scored across team velocity, data-integrity/domain fit, delivery/ops fit, forecasting fit, and operational cost — weighted 25/25/20/10/20 respectively (velocity and data-integrity weighted highest because a slow-to-ship or stock-corrupting MVP fails outright).

| Dimension (weight) | A — Next.js Monolith | B — Monolith + Python/FastAPI forecast svc | C — NestJS API + Next.js | D — Medusa.js |
|---|---|---|---|---|
| Team velocity (25%) | 10 | 4 | 6 | 3 |
| Data integrity & domain fit (25%) | 8 | 8 | 9 | 4 |
| Delivery/ops fit (20%) | 5 | 6 | 8 | 7 |
| Forecasting/analytics fit (10%) | 3 | 9 | 4 | 3 |
| Operational cost/complexity (20%) | 9 | 5 | 4 | 3 |
| **Weighted total** | **7.60** | 6.10 | 6.55 | 4.05 |

**Selected: Candidate A.** Postgres + Prisma's transactional guarantees (`$transaction` + `SELECT ... FOR UPDATE` where needed) are sufficient to enforce atomic multi-component stock decrement and tenant/store isolation without a dedicated service layer — the requirement doesn't need Candidate C's architectural weight to be satisfied safely.

**Candidate D (Medusa.js) is not viable**: its inventory/reservation model assumes every order line maps to a real stock-holding item at a location. A bundle SKU with *zero independent stock*, deriving sellable quantity from components, is not a first-class Medusa concept and would require fighting the framework's own data model — a structural, not incidental, mismatch with the core M2 requirement.

**Deferred, not rejected — Candidate B (Python/FastAPI forecasting service):** its only advantage (real statistics/ML tooling) is the one capability explicitly scoped as "naive heuristic is acceptable" for M1. Extract this as an isolated, read-only addition later — see Section 5.

## 3. Milestone 1 — MVP (single branch)

Scope, confirmed with stakeholder: **admin-only internal ops tool.** No public storefront, no customer checkout, no third-party courier integration, no statistical forecasting service.

| # | Milestone step | Notes |
|---|---|---|
| 1 | Schema design & migration | `Tenant`, `Store` (single row for M1), `Product`, `Variant`, `StockMovement`, `Order`, `OrderLine`, `Payment`, `Delivery`, `ForecastSnapshot`, `DeadStockFlag`. **Stub `Bundle`/`BundleComponent` tables now** (unused in M1) so M2 doesn't require a destructive migration. |
| 2 | Auth / tenant scaffold | Reuse horeca-pos's JWT pattern (jose + bcryptjs) and role-gated middleware. Add a nullable/defaulted `store_id` alongside `tenant_id` from day one so store-scoping is structurally present before M2 needs it. |
| 3 | Product & inventory CRUD (admin UI) | Manage products, variants, stock levels. Every stock change writes a `StockMovement` audit row. |
| 4 | Order-to-fulfillment core loop | Staff-entered orders; atomic stock decrement via Prisma `$transaction` with row locking; explicit status state machine: `pending → paid → fulfilling → fulfilled → cancelled`. Payment recording (method TBD — see open questions) rather than a public checkout flow. |
| 5 | Delivery status tracking | `Delivery` table with explicit statuses (`assigned → out_for_delivery → delivered/failed`); manual staff status-update UI. No courier webhook in M1 (structure the `Delivery` model so one can be added later without a schema break). |
| 6 | Background jobs (Vercel Cron) | Restock-threshold alert job; nightly forecast recompute (moving-average/seasonal heuristic in SQL/TS); nightly dead-stock scan. |
| 7 | Reporting/analytics surface | Admin dashboards: sales, inventory levels, restock suggestions, dead-stock flags. Read-only aggregate queries; CSV export. |
| 8 | Hardening pass | Concurrency tests for stock decrement under simultaneous order entry; tenant/store isolation audit; ad-hoc smoke-test scripts consistent with team convention. |

## 4. Milestone 2 — "Next Ambitious": Multi-Store + Build-to-Sell Bundles

### 4.1 Multi-store

- Move stock quantity **off** `Variant` and onto a per-store join table:
  `StoreStock(id, tenant_id, store_id → Store, variant_id → Variant, quantity_on_hand, reorder_threshold)`
- `Product` / `Variant` remain tenant-level catalog entities shared across stores; only stock, orders, and deliveries are store-scoped.
- Add a non-nullable `store_id` FK to `Order`, `Delivery`, and `StockMovement`; enforce a compound `(tenant_id, store_id)` index everywhere.
- Introduce a repository/service layer that requires an explicit `storeId` argument on every inventory/order query — this structurally prevents cross-store leakage rather than relying on every route remembering to filter.
- **Depends on an open question** (Section 6): whether stores nest strictly under one tenant, or multi-store implies a different tenancy shape.

### 4.2 Build-to-sell bundles

Schema:

```
Bundle (
  id, tenant_id, sku, name, price, is_active
)

BundleComponent (
  id,
  bundle_id             FK -> Bundle,
  component_variant_id  FK -> Variant,   -- leaf SKU (or another Bundle, see below)
  qty_required           int
)
```

- A `Bundle` row holds **no** `StoreStock` row of its own and is never a direct target of stock decrement.
- **Sellable quantity** (per store), computed at read time:
  `sellable_qty(bundle, store) = MIN over components of FLOOR(StoreStock.quantity_on_hand / BundleComponent.qty_required)`
  — either a live JOIN query, or cached in a short-TTL `BundleAvailabilityCache` if it becomes a hotspot.
- **Bundle-of-bundles**: if a `Bundle` can itself be a component of another bundle, resolve recursively to leaf `Variant`s before computing availability/decrement (recursive CTE or app-level resolver with cycle detection). `BundleComponent.component_variant_id` should reference a general "sellable item" rather than assuming components are always leaf variants, so this doesn't require a schema change later.

**Order fulfillment interaction** — the same `$transaction` used for single-SKU decrement in M1 is extended to, for each bundle order line:
1. Resolve the bundle to its (possibly nested) leaf components.
2. `SELECT ... FOR UPDATE` the `StoreStock` rows for every component, scoped to the order's `store_id`.
3. Verify `quantity_on_hand >= qty_required * order_qty` for every component.
4. Decrement all component `StoreStock` rows atomically; write one `StockMovement` per component, referencing both `bundle_id` and `order_line_id` for audit.
5. No row is ever created or decremented for the `Bundle` itself — its stock is always derived, never stored.

## 5. Future Hybrid: Forecasting Service (only if triggered)

The scoring supports exactly one hybrid, and only if triggered by need — not adopted preemptively:

**Trigger conditions** (any one is sufficient):
- Forecast accuracy needs move beyond moving-average/seasonal-naive (e.g. real Prophet/statsmodels-grade modeling requested).
- Dead-stock/forecast aggregate queries start measurably contending with order-entry latency on the shared Postgres instance.
- Nightly Vercel Cron jobs start hitting execution-time limits.

**When triggered:** stand up a FastAPI (Python) service reading from a Neon read replica or scheduled export, owning `ForecastSnapshot` / `RestockSuggestion` computation only, writing results back into the same Postgres tables the Next.js app already reads. This is additive and isolated — it does not touch the order/inventory/bundle transactional core.

**Do not** hybridize the order-fulfillment/inventory core itself (i.e. don't split that into NestJS or Medusa) — every scoring pass agrees the monolith handles that adequately, and splitting it multiplies operational surface for no corresponding requirement.

## 6. Open Questions / Risks

These don't block starting M1, but should be answered before the affected M1/M2 work is scoped in detail:

- **Payment recording model (M1):** since there's no public checkout, how is payment captured — manual/cash entry, a card-present flow (e.g. Stripe Terminal, consistent with horeca-pos's existing Stripe integration), or another method? This determines whether Stripe is even needed in M1 or only becomes relevant if a storefront is added later.
- **Multi-store tenancy shape (M2):** do all stores nest under a single tenant (one business, multiple physical locations), or could a tenant itself represent a multi-store franchise/B2B structure with different isolation needs? This determines whether `store_id` nests cleanly under `tenant_id` or needs its own boundary semantics.
- **Delivery evolution:** M1 is manual/in-house by design. If third-party courier integration is wanted later, which provider(s) — this affects the `Delivery` model's extensibility (webhook shape, external tracking ID field).
- **Storefront reconsideration:** M1 is admin-only by design. If a public storefront/checkout is added in a future milestone, bundle/component real-time availability (Section 4.2) must be checked at add-to-cart *and* at order-confirmation time to avoid overselling under concurrent public traffic — a stricter requirement than staff-entered orders.
- **Expected order volume/concurrency at launch:** informs how aggressive the row-locking/reservation strategy needs to be from day one vs. deferring further hardening to M2.
- **Data residency/compliance constraints:** affects Neon region choice and the future read-replica setup if the Section 5 forecasting service is ever triggered.

## Appendix: Source Assessment

- Full candidate scoring (all 5 dimensions, all 4 candidates, with justification per score) is available in the orchestration run that produced this handoff — ask if you want the raw comparison re-surfaced.
- Team stack precedent surveyed from `gritui/horeca-pos` (Next.js 16 + Prisma 7 + Neon + Tailwind v4 + Stripe + custom JWT, multi-tenant Prisma schema) and `gritui/sidekickz` (lighter Neon + Vercel-serverless-functions + vanilla JS pattern, also converges on Neon Postgres + Vercel + Stripe + custom JWT).
