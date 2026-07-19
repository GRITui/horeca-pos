# Grit BizSuite — Backlog

Tracked gaps and proposed designs from the monorepo pivot + WMS/promotions
epic. Nothing here is scheduled; this is a reference list for the next pass.
Update in place — add items as they're found, move items to a "Shipped"
note (or just delete) once built, and update the source commit/PR when a
partial fix lands.

## P0 — real gaps worth closing next

### Discount resolution policy (configurable per tenant)

**Problem:** `evaluatePromotions` (`apps/grit-pos/lib/promotions.ts`) applies
every matching rule with no conflict resolution — a cart can be discounted
twice by two rules that both scope the same SKU (e.g. a "3-for-2" and a
"bulk 10% off" both hitting the same gloves).

**Proposed design** (two independent layers — they solve different
problems, not alternatives to pick between):

1. **Per-line resolution policy — tenant-configurable, not hardcoded.**
   New tenant setting, e.g. `discountStackingPolicy` on `Tenant`:
   - `NO_STACKING` (recommended default) — for any line, compute every
     applicable rule and apply only the single best one by discount amount.
     Safe out of the box, no merchant configuration required.
   - `STACK_ALL` — today's behavior, every matching rule applies. A merchant
     who genuinely wants generous overlapping discounts (or who has
     verified their rules never actually overlap) can opt into this
     explicitly rather than have it be the silent default.
   - Configured in `apps/grit-inventory`'s promotion admin (`/admin/promotions`,
     alongside a "Discount rules" settings panel), since that's where a
     merchant already thinks about how promotions behave.

2. **Per-order exclusion rules — always available, independent of the
   policy above.** A promotion can name specific *other* promotions it must
   never co-apply with on the same order, checked at cart-evaluation time
   regardless of whether the two rules even touch the same SKUs (e.g. "New
   Customer 15% off" should never combine with storewide "Clearance," even
   on unrelated products — a margin/business-policy conflict, not a
   unit-level double-dip). This matters under *either* stacking policy
   above, since `NO_STACKING` only resolves conflicts within one line, not
   across an entire order.

**Schema (grit-inventory, additive):**
- `Tenant.discountStackingPolicy` — string enum-as-varchar (`NO_STACKING` |
  `STACK_ALL`), default `NO_STACKING`, matching the existing
  varchar+CHECK-as-string convention used for `Tenant.tier`.
- `PromotionExclusion` join table: `(promotionId, excludedPromotionId)`,
  undirected pair (dedupe/normalize ordering at write time so A-excludes-B
  and B-excludes-A collapse to one row). Managed from the promotion
  create/edit form: "This promotion cannot combine with: [multi-select of
  the tenant's other active promotions]."

**Sync to POS:** both the policy setting and the exclusion graph need to
reach POS's local cache the same way promotion rules already do (POS is
offline-first, never calls Inventory live at checkout). Reuse the
established event-bus pattern rather than inventing a new mechanism:
- Simplest: extend the `promotion.updated` envelope's data with an
  `excluded_promotion_ids: string[]` field per rule (small, no new event
  type) and add a *separate* small event for the tenant-wide policy —
  `discount_policy.updated { policy: "NO_STACKING" | "STACK_ALL" }` — since
  policy isn't per-promotion, it doesn't fit `promotion.updated`'s shape.
  (If more tenant-wide settings show up later, consider generalizing this
  into a `tenant_settings.updated` event instead of one-off event types per
  setting.)
- `apps/grit-pos`: `PromotionRule` cache gains `excludedRuleIds Json` (array
  of ids, mirroring how `items` is already stored); a new small
  `TenantSetting`-ish cache row (or a single `discountStackingPolicy` column
  bolted onto whatever the POS-side tenant/session table is) holds the
  synced policy.
- `evaluatePromotions` changes shape: still computes every applicable rule
  first, then a resolution step applies the policy (best-per-line filter
  under `NO_STACKING`) and finally strips out any rule pair that violates an
  exclusion, before summing the discount.

**Open questions for whoever picks this up:**
- Does `NO_STACKING`'s "best rule" tiebreak need to be deterministic beyond
  "highest discount amount" (e.g. a stable secondary sort by rule creation
  order, so two equally-good rules don't flip-flop between requests)?
- Should exclusion be transitive/grouped (an "exclusivity group" of 3+
  mutually-exclusive promotions) or is pairwise sufficient for the
  business sizes this platform targets? Pairwise is simpler to build and to
  explain in the UI; groups scale better once a tenant has more than a
  handful of promotions.

### VAT-inclusive pricing (Thailand 7%, per-item exempt flag)

**Problem:** POS has no tax model at all today — `tax_amount` is hardcoded
to `0` on every `transaction.completed` event, and `Variant.price` is just
a flat sticker price with no VAT concept behind it.

**Requirement (as specified):** selling price defaults to **VAT-inclusive**
at Thailand's standard rate (7%) — the price staff enter and customers see
*is* the tax-inclusive price, and the excl-VAT/VAT split is derived from it
for receipts and reporting, not entered separately. Some items are
VAT-exempt by law, so this needs to be a **per-item flag**, not a
tenant-wide switch.

**Example (from the request):** sticker price 214 THB → price excl. VAT =
200 THB, VAT = 14 THB. I.e. `priceExclVat = price / 1.07`,
`vat = price - priceExclVat` (equivalently `price × 7/107`).

**Proposed design:**
- `Variant.vatApplicable: Boolean @default(true)` (`apps/grit-pos`'s
  Variant model) — per-SKU opt-out for legally VAT-exempt items. Default
  `true` since most retail goods are standard-rated; staff flip it off per
  item where the law requires it.
- `price` stays the single source of truth (VAT-inclusive when
  `vatApplicable`) — no new stored "excl-VAT price" column. Excl-VAT and
  VAT amounts are computed at render/receipt/reporting time from `price`
  and the flag, same pattern as `subtotal`/`discountTotal` are already
  derived-not-stored on `OrderDTO` (see `apps/grit-pos/app/api/orders/_lib/queries.ts`).
- **Don't hardcode 7%.** Thailand's VAT rate is set by periodically-renewed
  cabinet resolution (has been temporarily raised before) — make it a
  tenant-level setting (e.g. `Tenant.vatRate: Decimal @default(7.00)`) so a
  rate change is a config update, not a code change, and so the platform
  isn't Thailand-only if it's ever needed elsewhere.
- Order/receipt total needs a proper VAT breakdown, not just a single
  number: subtotal excl. VAT, VAT amount, VAT-exempt subtotal (for mixed
  carts), total incl. VAT — a real Thai tax invoice (ใบกำกับภาษี) itemizes
  VAT-applicable and VAT-exempt subtotals separately, it doesn't just show
  one blended tax line.
- Populating `tax_amount` on `transaction.completed` with the real computed
  VAT total closes the existing "no tax model" gap noted elsewhere in this
  doc, and would also feed `DailyReconciliation` (currently cash/card/qr/
  stripe totals only, no VAT liability column) for daily tax filing.

**Open questions for whoever picks this up:**
- Does `grit-inventory`'s own B2B `Order`/`OrderLine` pricing need the same
  treatment for wholesale invoices, or is this POS-only for now (retail
  checkout is the only place a "sticker price" concept really applies)?
- Exempt vs. zero-rated: Thai VAT law actually distinguishes VAT-exempt
  goods from zero-rated (0%) goods (e.g. exports) — both mean "no VAT
  charged" at checkout but are reported differently for filing. A single
  `vatApplicable: Boolean` collapses that distinction; fine for MVP, but
  flag it if proper VAT filing support is ever in scope.

### Other P0s

- **No automated tests for the WMS/promotions modules.** Groups, locations,
  picking, packing, labels, promotions — all verified live by hand, zero
  automated coverage. `apps/grit-inventory` has no test framework at all
  (ad-hoc scripts only); this epic didn't add any.
- **Dashboard stat cards beyond "Low stock" not audited** for the same
  aggregate-vs-per-store masking bug that was found and fixed on the
  low-stock widget — "Open orders," "Deliveries in flight" etc. on
  `/admin/dashboard` were never specifically checked across multi-location
  tenants.
- ~~**CI/sandbox gap:** `test-stripe-webhook.mjs` couldn't run.~~ **Fixed.**
  Root cause was the test itself, not the environment: it hardcoded a deep
  relative import `../node_modules/stripe/esm/stripe.esm.node.js`, which
  only ever resolves if `stripe` is installed directly inside
  `apps/grit-taskboard/node_modules` — under npm workspace hoisting it
  lives in the root `node_modules` instead, so the path 404'd. Switched to
  the bare specifier `import Stripe from 'stripe'` (Node's resolver walks
  up to the hoisted install; the package's `exports` map only exposes the
  top-level entry point anyway, not that deep subpath). `4 passed, 0
  failed` locally now.

## P1 — documented design decisions worth revisiting

- **Full SSO is still a bridge, not real.** Every app derives a
  `GritSession` from its own existing login rather than sharing one
  session; a user logs into POS and Inventory separately even though
  `@grit/passport`'s session shape is already unified across apps.
- **POS's synthetic SKU fallback** (`PRD-<internal-id>` when a line has no
  variant SKU) can't be matched by Inventory — cross-app stock decrement
  silently skips those items. Needs shared/real SKUs on both catalogs.
- **No Location model in POS** — the tenant/org id stands in for "the
  default store" on events (see the VAT-inclusive pricing P0 above for the
  related "no tax model" gap, now fleshed out separately).
- **Parcel labels are decorative, not scannable.** Self-drawn bar pattern,
  no real barcode symbology (Code128/QR), no carrier integration —
  intentionally an "internal MVP label" per its own doc comment.
- **Pick/pack/label mutations have no ADMIN gate**, unlike
  groups/locations/promotions (matches the existing `/transition` and
  `/payments` routes' "any staff on the floor" model). Tried adding an
  ADMIN gate to `pick-tasks/[id]/scan`, `pack-tasks/[id]/scan`, and
  `parcel-labels/[id]` (PATCH) during the Wave 1 backlog pass and reverted
  it on review: these aren't admin-config actions like groups/locations/
  promotions, they're the actual scan-a-barcode operational steps the
  picking/packing epic was explicitly built for ("let staff use scanner to
  scan barcode when picking and packaging" — the original requirement).
  Gating them to ADMIN would lock ordinary floor staff out of picking and
  packing entirely. Left ungated, matching `/transition`/`/payments`. If
  this ever needs a real access-control decision, it should be a distinct
  "who can complete a pick/pack step" product call, not a copy-paste of
  the groups/locations/promotions ADMIN pattern.
- **Reports' daily margin/COGS breakdown is null** — Inventory's COGS
  endpoint only returns a period total, so the dashboard can't chart it per
  day.
- **Taskboard's persona onboarding has no "trading company" option** — the
  live demo routed around it by picking "Other"; real trading-company
  signups hit the same gap.

### POS ↔ Inventory SKU alignment (scoping)

**Problem:** `eventItemSku` (`apps/grit-pos/lib/events.ts:86-88`) resolves an
order line's SKU as `line.variantSku ?? \`PRD-${line.productId}\``, and all
three `transaction.completed` publish sites feed it `line.variant?.sku ??
null` (`app/api/orders/[orderId]/tender/route.ts:143`,
`app/api/stripe/webhook/route.ts:130`, `app/api/orders/offline-sync/route.ts:108,277`).
On the inventory side, `handleTransactionCompleted`
(`apps/grit-inventory/src/app/api/events/grit/route.ts:148-154`) looks up
each incoming item strictly by `tx.variant.findUnique({ where: {
tenantId_sku: { tenantId, sku: item.sku } } })`; a miss pushes a `warnings`
string and `continue`s — the item is skipped, the webhook still returns HTTP
200 (`route.ts:80`, `:186-187`). Nothing ever reads that `warnings` array:
`GritEventBus.deliver` (`packages/shared-events/src/bus.ts:128-162`) only
checks `res.ok` for retry bookkeeping, never the response body, and
`publishTransactionCompleted` is fire-and-forget by design
(`apps/grit-pos/lib/events.ts:113-138`). So "silently skips" is accurate on
both ends today — not just a POS-side gap, there is no code path anywhere in
either app that would surface a skipped item to a human.

**How often the fallback actually fires (not an edge case):** `OrderLine.variantId`
is optional (`apps/grit-pos/prisma/schema.prisma:237`) and the add-line API
treats "no variant" as a normal, unvalidated path, not a guarded exception
(`app/api/orders/[orderId]/lines/route.ts:9-14,56-62` — `variantId` is an
optional body field, and a `null` variant flows straight into
`OrderLine.create`). `Variant.sku` itself is also optional
(`prisma/schema.prisma:178`, comment: "legacy hospitality variants have
neither tenantId nor sku"). A real child SKU only gets populated
automatically for **matrix** retail products, via
`buildChildSku`/`expandChildSkus` (`apps/grit-pos/lib/variantMatrix.ts:89-106`),
which requires the variant to carry an `attributes` JSON (size/color axes
etc.) — that machinery never runs for a plain hospitality menu item (a
coffee, a plate) sold with no variant at all, or for a simple non-matrix
variant (e.g. a bare "Large" with no attributes) that nobody hand-entered a
SKU for. Given AGENTS.md's framing — "Hospitality features are optional
plugin traits; core is channel-agnostic checkout" — the fallback is the
*default* path for hospitality-style tenants and only reliably avoided by
retail tenants who use the matrix builder. This is a routine, everyday
occurrence for a large slice of the tenant base, not a rare
malformed-data corner case.

**Is there an existing shared-identity concept to lean on?** No. Grepped
`apps/grit-inventory/prisma/schema.prisma` for `externalId`/`sourceId`/
`posProductId`/similar — no matches. Inventory's `Product`/`Variant` models
(`prisma/schema.prisma:163-230`) and POS's (`apps/grit-pos/prisma/schema.prisma:144-189`)
are entirely separate `cuid()` spaces with zero cross-referencing columns;
the only cross-app identity bridges that exist anywhere in the platform are
`organization_id` ⟷ `Tenant.id` by equality and `location_id` ⟷ `Store.id`
(both documented in `apps/grit-inventory/README.md` and mirrored in the
webhook handler's comments), and neither of those is a product/variant-level
concept. Inventory's own internal workflows are *also* entirely SKU-string
keyed end to end — barcode scan lookup, `/admin/products` "assign to
variant," `GET /api/variants/lookup?sku=` (`apps/grit-inventory/README.md:236-239,467`)
— so SKU-as-identity isn't just this webhook's shortcut, it's how the whole
app thinks about product identity today. There is also no existing
catalog-sync event from Inventory → POS (the only inbound sync event POS
consumes today is `promotion.updated`); a productId-based fix would need to
invent that channel, not just extend one that already exists.

**Candidate approaches:**

1. **Require every POS variant to carry Inventory's canonical SKU at
   creation time** (make `sku` effectively mandatory before a line can be
   sold, or at least warn staff hard in the UI). Cheapest — no schema or
   event-contract changes, the matching code as written already works once
   the string matches. But it pushes a SKU-literacy burden onto
   hospitality staff for whom "SKU" isn't a natural checkout concept, and it
   doesn't solve the actual problem: nothing keeps the two catalogs' SKU
   strings in sync after creation (an Inventory-side rename doesn't
   propagate to POS's copy), so this just moves the silent-skip failure
   mode to "whoever forgot to keep the two strings identical" instead of
   removing it.
2. **Add a real shared identity — a `productId`/`variantId` link pushed from
   Inventory to POS** (e.g. a new `Variant.inventoryVariantId String?` on
   POS's schema, populated via a new Inventory → POS catalog-sync event,
   analogous to how `promotion.updated` already seeds POS's promotion
   cache). `transaction.completed` items would carry this id alongside
   `sku`, and the webhook handler would try id-match first, SKU-match as
   fallback. Fixes the actual root cause (identity, not formatting) and
   works even for lines that will never have a human-meaningful SKU. But
   it's a real feature, not a bugfix: it requires building a catalog-sync
   mechanism that doesn't exist yet, and it forces an answer to "which app
   owns the canonical catalog" that the platform has so far avoided (see
   open questions) — this is exactly the shape of thing this backlog entry
   was flagged as too large to hand a builder blind.
3. **Best-effort stopgap: make the existing skip visible instead of fixing
   matching.** Leave SKU-string matching as-is, but stop discarding the
   `warnings` data on the floor — write skipped items to a small
   "unmatched sale" table/admin queue in Inventory instead of just a log
   string (`route.ts:151-153`), so a human can reconcile manually, and/or
   have `publishTransactionCompleted`'s caller actually inspect delivery
   results instead of ignoring them. Smallest change, and directly answers
   the severity flag in this backlog item ("silently skips" → "visibly
   skips, queued for review") without redesigning catalog identity. Doesn't
   reduce how often the mismatch happens, and a name-based fuzzy-match
   enhancement on top of this would trade silent under-decrementing for a
   real chance of decrementing the *wrong* SKU, which is worse, not better;
   treat fuzzy matching as unfit to be the primary mechanism.

**Open questions for whoever scopes this:**
- Should Inventory become the single source of truth for the shared catalog
  (matching how `@grit/database` is described as the "canonical relational
  schema" in the root AGENTS.md), with POS consuming Inventory's catalog
  rather than maintaining its own separate `Product`/`Variant` tables? That
  is a much larger unification than this ticket and would make approach 2
  moot in its current form (there'd be nothing to "link," POS just
  wouldn't own the data). Worth resolving the direction before building
  approach 2's sync channel, so it isn't thrown away.
- Are all of the currently-skipped lines actually supposed to decrement
  Inventory stock? Some fraction of "no SKU" hospitality lines (a
  made-to-order coffee, a plated dish) may correctly have no discrete
  inventory unit at all — in which case today's skip is arguably correct
  behavior, not a bug, and the real gap is purely the *silence*, not the
  skip. Needs product input on which POS product types should participate
  in cross-app stock decrement before choosing an enforcement mechanism (1
  or 2) that would force SKUs onto items that were never meant to have one.
- If approach 1 is chosen regardless, who/what backfills SKUs on existing
  live tenants' untagged variants, and what happens to sales of legitimately
  un-SKU'd items during the gap — hard-fail the line, or keep today's
  silent skip until backfill completes?

## P2 — smaller / longer-tail

- `VariantLocation.isPrimary` is app-enforced only, no DB constraint — could
  end up with two "primary" rows for the same SKU+store under a future bug.
- Grit-inventory's original `Bundle`/`BundleComponent` model (build-to-sell
  composite SKUs, from the M1 handoff) remains stubbed and unused — a
  different concept from the new `bundle_deal` promotion type.
- No public storefront/checkout for Inventory, no real courier integration
  for Deliveries, no ML forecasting (still naive moving-average) — all
  called out as explicitly out of scope since the original M1 handoff doc.
- Turbopack can't resolve the shared packages' `.js→.ts` specifiers, so both
  Next apps build pinned to webpack — fixable with an extensionless-import
  cleanup in `packages/`, not urgent.
