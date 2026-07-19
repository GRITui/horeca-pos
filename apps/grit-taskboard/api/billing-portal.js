/* Sidekick — api/billing-portal.js
 *
 * Hands back a Stripe-hosted Billing Portal URL so an account can view
 * invoices, update its card, or cancel — self-service, no custom
 * cancel/update-card UI to build here (same "defer to Stripe's hosted
 * flow" reasoning as api/billing-checkout.js).
 *
 * Restricted to account owners (never a team member) — see
 * lib/teams.js's isAccountOwner(). For a Team-plan account this is also
 * deliberately where seat-count CHANGES happen: rather than building a
 * bespoke "add more seats" flow, the Portal's own quantity-editing feature
 * covers it, as long as it's enabled in the Stripe Dashboard (Customer
 * Portal settings → Subscriptions → "Customers can update quantities") —
 * one more by-hand setup step, api/stripe-webhook.js already re-syncs
 * users.team_seats on any subscription.updated event, including a
 * quantity change made there.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight, appUrl } from '../lib/cors.js';
import { stripeClient } from '../lib/stripe.js';
import { isAccountOwner } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const sql = db();
  try {
    if (!(await isAccountOwner(sql, session.userCuid))) {
      return json({ error: 'Only the account owner can manage billing' }, 403, request);
    }
    const [user] = await sql(
      `select stripe_customer_id from users where cuid = $1`,
      [session.userCuid]
    );
    if (!user) return json({ error: 'Account not found' }, 404, request);
    if (!user.stripe_customer_id) {
      return json({ error: 'No subscription yet — checkout first', code: 'no_customer' }, 409, request);
    }

    const portalSession = await stripeClient().billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl(request)}/?screen=more`,
    });

    return json({ url: portalSession.url }, 200, request);
  } catch (err) {
    console.error('billing-portal handler error', err.message);
    return json({ error: 'Could not open billing portal' }, 502, request);
  }
}

// Node.js runtime, not edge — see api/billing-checkout.js's header comment
// on this same line: the `stripe` npm package needs real Node core modules
// that Edge Runtime doesn't provide.
export const config = { runtime: 'nodejs' };
