import "server-only";

// ---------------------------------------------------------------------------
// Stripe payout cross-check — STUBBED.
//
// `stripeTotal` on DailyReconciliation is derived from our own `Payment`
// rows (tenderType: "stripe", status: "succeeded") — i.e. what our database
// *thinks* was collected via Stripe that business day. A real close-out
// process should cross-check that figure against what Stripe itself reports
// actually settling, since our webhook could in principle miss/duplicate an
// event, or a charge could later be disputed/refunded outside our record.
//
// No live Stripe account or API keys are configured in this environment
// (see lib/stripe.ts / .env.example), so this deliberately does NOT call the
// Stripe API or fabricate a number — it returns a clearly-marked
// "unavailable" result. Wire this up for real once there's a Stripe account
// to query.
// ---------------------------------------------------------------------------

export interface StripePayoutCheck {
  /** Whether a real cross-check total was computed. Always `false` here. */
  available: false;
  /** The cross-check total, once implemented. Always `null` here. */
  total: null;
  note: string;
}

/**
 * TODO(production): implement the real cross-check. Sketch:
 *
 *   1. Resolve this tenant's Stripe account/customer scoping. Today every
 *      tenant shares one platform `STRIPE_SECRET_KEY` (see lib/stripe.ts) —
 *      there's no per-tenant Stripe Connect account id to filter by yet, so
 *      step 2 below can't be scoped correctly until that's added.
 *   2. Call the Stripe API for the given business day's UTC range, e.g.
 *      `stripe.balanceTransactions.list({ created: { gte, lt }, type: "charge" })`
 *      (https://docs.stripe.com/api/balance_transactions/list) or the
 *      Payouts API (https://docs.stripe.com/api/payouts) depending on
 *      whether "expected" here means gross charges or net payout.
 *   3. Sum `amount` (and separately `fee`, if reconciling net-of-fees) across
 *      the returned transactions, converting Stripe's minor-unit integers
 *      back to the same Decimal shape as `stripeTotal`.
 *   4. Return `{ available: true, total, note }` so the UI can diff it
 *      against `stripeTotal` and flag a variance.
 *
 * @param tenantId unused until per-tenant Stripe account scoping exists.
 * @param businessDate unused until step 2 is implemented.
 */
export async function getStripePayoutTotal(
  tenantId: string,
  businessDate: Date,
): Promise<StripePayoutCheck> {
  void tenantId;
  void businessDate;
  return {
    available: false,
    total: null,
    note:
      "Stripe payout cross-check is not implemented in this environment (no live Stripe account " +
      "configured). See getStripePayoutTotal() in app/api/reconciliation/_lib/stripePayout.ts for " +
      "the production implementation plan — the stripeTotal above is our own Payment-table figure, " +
      "not independently verified against Stripe.",
  };
}
