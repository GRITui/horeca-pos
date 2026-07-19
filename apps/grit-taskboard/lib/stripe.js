/* Sidekick — lib/stripe.js
 *
 * Single shared Stripe client point, mirroring lib/db.js's lazy-singleton
 * shape. Uses Stripe's own Web-Crypto-backed subtle-crypto provider (not
 * Node's `crypto` module) so this also works from edge-runtime functions —
 * api/stripe-webhook.js needs that, since raw-body signature verification
 * has to run before any Node-only API is guaranteed available.
 */
import Stripe from 'stripe';

let stripe = null;
export function stripeClient() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set — add it in the Vercel dashboard first.');
    stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  }
  return stripe;
}

// Edge-compatible webhook signature verification — Stripe's default
// webhooks.constructEvent() assumes Node's `crypto`, which isn't guaranteed
// on Vercel's edge runtime. createSubtleCryptoProvider() is Stripe's own
// documented escape hatch for exactly this (same technique this project
// already uses by hand in lib/line.js/lib/lineLogin.js for their own
// HMAC checks, but Stripe ships a maintained version of it directly).
let cryptoProvider = null;
export async function verifyStripeWebhook(rawBody, signature, secret) {
  if (!cryptoProvider) cryptoProvider = Stripe.createSubtleCryptoProvider();
  return stripeClient().webhooks.constructEventAsync(rawBody, signature, secret, undefined, cryptoProvider);
}
