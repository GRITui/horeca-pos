/* Sidekick — api/stripe-webhook.js
 *
 * Keeps users.subscription_status/plan/current_period_end in sync with
 * Stripe's own subscription state machine. Deliberately listens to only
 * the customer.subscription.* events (created/updated/deleted) rather than
 * also handling checkout.session.completed/invoice.payment_failed/etc
 * separately — Checkout in subscription mode always creates a Subscription
 * object (firing customer.subscription.created right after), and Stripe's
 * own `subscription.status` field already reflects active/past_due/
 * canceled/trialing accurately, so one mapping function driven by Stripe's
 * canonical state is simpler and more robust than juggling several
 * overlapping event types by hand.
 *
 * WEBHOOK DELIVERY ORDERING: Stripe webhooks may arrive out-of-order — a
 * delayed 'customer.subscription.updated' can overwrite newer local state
 * with stale event data. RECONCILIATION mitigates this by fetching the
 * current subscription state directly from Stripe (stripeClient().subscriptions
 * .retrieve(sub.id)) after webhook signature verification, then applying
 * Stripe's authoritative status/current_period_end/metadata/items instead
 * of the possibly-stale event payload. 'subscription.deleted' skips the
 * retrieve entirely and uses the event payload as-is — Stripe's payload for
 * this event is already the terminal 'canceled' state, so there's nothing
 * to reconcile. Try/catch wraps retrieves: on failure we fall back to event payload
 * (current behavior) and console.error, ensuring a failed reconciliation fetch
 * never drops the update entirely. This approach is simpler than ordering
 * bookkeeping (no schema column needed) and always picks the newest state.
 *
 * Same raw-body-signature-verification shape as api/line-webhook.js (see
 * that file's header for why Request/Response beats Vercel's classic
 * (req,res) helper here) — Stripe's signature check needs the exact
 * untouched raw bytes too. Runs on the Node.js runtime, not edge, unlike
 * api/line-webhook.js — see the `config.runtime` line at the bottom of
 * this file for why.
 */
import { db } from '../lib/db.js';
import { verifyStripeWebhook, stripeClient } from '../lib/stripe.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// Maps Stripe's subscription.status onto this app's narrower
// subscription_status check constraint (trialing|active|past_due|
// canceled). Stripe has a few extra states (incomplete,
// incomplete_expired, paused) this app never intentionally creates
// (checkout always goes straight to card-collected + active/trialing) —
// treated as canceled (i.e. locked) rather than left unmapped, since
// "not actively paying" is the correct read for all of them.
function mapStripeStatus(stripeStatus) {
  if (stripeStatus === 'active') return 'active';
  if (stripeStatus === 'trialing') return 'trialing';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  return 'canceled';
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  let event;
  try {
    event = await verifyStripeWebhook(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('stripe-webhook signature verification failed', err.message);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    let sub = event.data.object;

    // For subscription.created and subscription.updated, reconcile with
    // Stripe's current state to guard against out-of-order delivery.
    // subscription.deleted events use the event payload as-is since the
    // retrieve would 404 or return status 'canceled' anyway.
    if (event.type !== 'customer.subscription.deleted') {
      try {
        const current = await stripeClient().subscriptions.retrieve(sub.id);
        // Apply Stripe's authoritative state instead of the possibly-stale event data.
        sub = current;
      } catch (err) {
        // Reconciliation fetch failed (network, 5xx, etc). Fall back to event
        // payload and continue — a failed fetch must never drop the update.
        console.error('stripe-webhook reconciliation fetch failed', err.message);
      }
    }

    const status = mapStripeStatus(sub.status);
    const currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    const plan = (sub.metadata && sub.metadata.plan) || null;
    // Team seat count (Phase 2): the subscription line item's quantity —
    // set at Checkout (api/billing-checkout.js) and re-read here on every
    // update, so a seat-count change made through the Billing Portal
    // (api/billing-portal.js's own header explains why that's the intended
    // path, not a bespoke in-app control) re-syncs automatically the
    // moment Stripe fires this same event for the edit. Meaningless for
    // basic/pro (always 1 there) but harmless to store regardless.
    const quantity = sub.items && sub.items.data && sub.items.data[0] ? sub.items.data[0].quantity : null;

    const sql = db();
    try {
      // Matched by stripe_customer_id, not metadata.userCuid — stays
      // correct even for a subscription later edited by hand in the
      // Stripe dashboard, which wouldn't carry this app's metadata.
      // `plan` only overwrites when Stripe actually sent one (present at
      // Checkout-created time via subscription_data.metadata in
      // api/billing-checkout.js); a dashboard-initiated change with no
      // metadata leaves the existing plan column untouched rather than
      // nulling it out.
      if (plan) {
        await sql(
          `update users set subscription_status = $1, current_period_end = $2, stripe_subscription_id = $3, plan = $4, team_seats = $5 where stripe_customer_id = $6`,
          [status, currentPeriodEnd, sub.id, plan, quantity, sub.customer]
        );
      } else {
        await sql(
          `update users set subscription_status = $1, current_period_end = $2, stripe_subscription_id = $3, team_seats = $4 where stripe_customer_id = $5`,
          [status, currentPeriodEnd, sub.id, quantity, sub.customer]
        );
      }
    } catch (err) {
      // Stripe retries on a non-2xx response — log and still ack, matching
      // api/line-webhook.js's same "don't cause a redundant retry storm
      // over a logged, investigable error" call.
      console.error('stripe-webhook DB update failed', err.message);
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

// Node.js runtime, not edge — see api/billing-checkout.js's header comment
// on this same line: the `stripe` npm package needs real Node core modules
// Edge Runtime doesn't provide, even though this specific handler's own
// signature verification (verifyStripeWebhook) never makes an outbound
// call — the crash happens at `import Stripe from 'stripe'` in
// lib/stripe.js, before any handler code runs, so it hits every file that
// imports it equally. Raw-body access for signature verification
// (`request.text()`) is unaffected by this switch — Vercel's Node.js
// runtime supports the same Web-standard Request/Response handler export
// this file already uses, without applying the classic (req,res)
// body-parsing middleware that would otherwise mangle the raw bytes.
export const config = { runtime: 'nodejs' };
