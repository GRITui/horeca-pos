/* Sidekick — api/billing-checkout.js
 *
 * Starts a real subscription: creates (or reuses) a Stripe Customer for the
 * caller's account, then a Stripe-hosted Checkout Session for the chosen
 * plan, and hands back its URL for the client to redirect to. Stripe's own
 * hosted page collects the card — this endpoint never sees one, so this app
 * stays out of PCI scope entirely, same reasoning as everything else here
 * that defers to a hosted flow rather than building a custom form.
 *
 * 'team' (Phase 2, 2026-07-15): seat-quantity subscription, priced per
 * seat — `seats` in the request body sets the Checkout line item's
 * quantity, which api/stripe-webhook.js later reads back off the created
 * subscription into users.team_seats. Minimum 2 (an owner alone has no
 * need for seat billing at all — that's just the Pro plan).
 *
 * Restricted to account owners only (never a team member, admin or not) —
 * see lib/teams.js's isAccountOwner()/header comment for why billing stays
 * with whoever actually holds the account, regardless of role.
 *
 * Requires STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM env
 * vars, set to real Stripe Price IDs created by hand in the Stripe
 * Dashboard (Products → add a recurring monthly THB price for each plan,
 * STRIPE_PRICE_TEAM's Price configured as per-unit/per-seat) — there is no
 * API call in this codebase that creates Prices, matching this project's
 * existing "schema/config applied by hand, no automation for one-time
 * setup" habit (sql/schema-core.sql, the LINE channel setup, etc.).
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

const PRICE_ENV_BY_PLAN = { basic: 'STRIPE_PRICE_BASIC', pro: 'STRIPE_PRICE_PRO', team: 'STRIPE_PRICE_TEAM' };
const MIN_TEAM_SEATS = 2;

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const body = await request.json().catch(() => null);
  const plan = body && body.plan;
  const priceEnvKey = PRICE_ENV_BY_PLAN[plan];
  if (!priceEnvKey) return json({ error: 'plan must be "basic", "pro", or "team"' }, 400, request);
  const priceId = process.env[priceEnvKey];
  if (!priceId) return json({ error: `Server misconfigured — ${priceEnvKey} is not set` }, 500, request);

  let quantity = 1;
  if (plan === 'team') {
    quantity = Math.floor(Number(body.seats));
    if (!Number.isInteger(quantity) || quantity < MIN_TEAM_SEATS) {
      return json({ error: `seats must be an integer of at least ${MIN_TEAM_SEATS}` }, 400, request);
    }
  }

  const sql = db();
  try {
    if (!(await isAccountOwner(sql, session.userCuid))) {
      return json({ error: 'Only the account owner can manage billing' }, 403, request);
    }
    const [user] = await sql(
      `select cuid, username, stripe_customer_id from users where cuid = $1`,
      [session.userCuid]
    );
    if (!user) return json({ error: 'Account not found' }, 404, request);

    const stripe = stripeClient();
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        // `username` doubles as the login identifier for password accounts
        // (see api/auth-register.js) — not guaranteed to be a real email,
        // but it's the only contact-ish field this app collects today.
        // Validate basic email format to prevent junk like 'a@b' in Stripe receipts.
        email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user.username) ? user.username : undefined,
        metadata: { userCuid: user.cuid },
      });
      customerId = customer.id;
      await sql(`update users set stripe_customer_id = $1 where cuid = $2`, [customerId, user.cuid]);
    }

    // appUrl, not resolveOrigin: GitHub Pages serves the app under /Sidekickz —
    // a bare-origin redirect 404s. See lib/cors.js appUrl().
    const origin = appUrl(request);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.cuid,
      line_items: [{ price: priceId, quantity }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      metadata: { userCuid: user.cuid, plan },
      subscription_data: { metadata: { userCuid: user.cuid, plan } },
    });

    return json({ url: checkoutSession.url }, 200, request);
  } catch (err) {
    console.error('billing-checkout handler error', err.message);
    return json({ error: 'Could not start checkout' }, 502, request);
  }
}

// Node.js runtime, not edge: the `stripe` npm package's Node SDK relies on
// Node core modules (its default HTTP client, certificate/agent handling)
// that Vercel's Edge Runtime doesn't support — importing it there crashes
// at module-load time, before this handler ever runs, producing a bare
// platform-level 500 with zero outgoing requests logged (not this file's
// own try/catch's 502). Every other api/*.js endpoint stays on 'edge'
// because none of them import lib/stripe.js. This still exports the same
// Web-standard Request/Response handler shape as the rest of this
// codebase — Vercel's Node.js runtime supports that export style too, so
// nothing else about this file needed to change.
export const config = { runtime: 'nodejs' };
