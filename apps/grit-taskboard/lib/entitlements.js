/* Sidekick — lib/entitlements.js
 *
 * Single source of truth for "what can this account do right now," reading
 * straight off a `users` row (the snake_case shape a Postgres query returns
 * — cuid/plan/subscription_status/trial_ends_at/stripe_customer_id/
 * stripe_subscription_id/current_period_end, see sql/schema-core.sql).
 * Replaces the old `settings.premiumUnlocked`
 * per-device local flag (app/research.js) as the real, server-verified
 * entitlement check going forward — that flag stays as-is for now (moving
 * Research's own gate onto this layer is a Phase 1 follow-up, not done in
 * this pass), but every *new* gate should read from here, not invent its
 * own flag.
 *
 * Deliberately has no dependency on lib/db.js or lib/stripe.js — pure
 * functions over a plain object, so this is trivial to unit-test without a
 * live Neon/Stripe connection (see test/entitlements.test.js).
 */

export const PLANS = ['basic', 'pro', 'team'];

// Feature flags per plan. 'basic' intentionally omits everything below it —
// callers check hasFeature(user, key), not plan tier directly, so adding a
// plan or a feature later never means hunting down every call site.
const PLAN_FEATURES = {
  basic: { clientCap: 15, cloudSync: false, lineBooking: false, recurringBookings: false, researchPremium: false, docBranding: false },
  pro:   { clientCap: Infinity, cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
  team:  { clientCap: Infinity, cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
};

// Boolean feature keys only (excludes clientCap, which is numeric — see
// clientCapFor()). api/auth-session.js iterates this to hand the client a
// plain {key: boolean} map instead of duplicating PLAN_FEATURES client-side
// — app/app.js stays a dumb reader of server-computed flags, same reasoning
// as everything else in this file being the one place plan logic lives.
export const FEATURE_KEYS = Object.keys(PLAN_FEATURES.pro).filter(k => k !== 'clientCap');

function planKey(user) {
  return PLAN_FEATURES[user && user.plan] ? user.plan : 'basic';
}

// Whether this account is in a read-only/locked state right now — computed
// live off subscription_status + trial_ends_at, not a stored flag, so it's
// always correct without a background job flipping it. The only state this
// actually needs to check the clock for is 'trialing': this app doesn't
// take a card at signup (see api/auth-register.js), so a 'trialing' row is
// the one case with no Stripe subscription backing it up yet. 'past_due'/
// 'canceled' are Stripe-driven (api/stripe-webhook.js sets them) and are
// locked unconditionally; 'active' is never locked.
export function isLocked(user) {
  if (!user) return true;
  const status = user.subscription_status;
  if (status === 'active') return false;
  if (status === 'trialing') {
    if (!user.trial_ends_at) return false; // no clock to compare against — never-expiring, not locked
    return new Date(user.trial_ends_at).getTime() <= Date.now();
  }
  // 'past_due' | 'canceled' | anything unrecognized
  return true;
}

export function hasFeature(user, feature) {
  if (isLocked(user)) return false;
  const flags = PLAN_FEATURES[planKey(user)];
  return !!(flags && flags[feature]);
}

export function clientCapFor(user) {
  return PLAN_FEATURES[planKey(user)].clientCap;
}

// Whole-account read-only check for lib/crudHandler.js's write guard — a
// locked account can still GET (read) its own data (per the product
// decision: downgrade to locked/read-only, not full lockout), just can't
// POST/PUT/DELETE until it's unlocked again (trial-end payment, or a
// resolved past_due).
export function canWrite(user) {
  return !isLocked(user);
}

export function trialDaysLeft(user) {
  if (!user || user.subscription_status !== 'trialing' || !user.trial_ends_at) return null;
  const ms = new Date(user.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}
