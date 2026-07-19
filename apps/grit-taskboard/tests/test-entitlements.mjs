import { isLocked, hasFeature, clientCapFor, canWrite, trialDaysLeft } from '../lib/entitlements.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const future = (days) => new Date(Date.now() + days * 86400000).toISOString();
const past = (days) => new Date(Date.now() - days * 86400000).toISOString();

// isLocked
assert(isLocked(null) === true, 'null user is locked');
assert(isLocked({ subscription_status: 'active' }) === false, 'active is never locked');
assert(isLocked({ subscription_status: 'trialing', trial_ends_at: future(5) }) === false, 'trial with days left is not locked');
assert(isLocked({ subscription_status: 'trialing', trial_ends_at: past(1) }) === true, 'expired trial is locked');
assert(isLocked({ subscription_status: 'trialing', trial_ends_at: null }) === false, 'trialing with no trial_ends_at (grandfathered edge case) is not locked');
assert(isLocked({ subscription_status: 'past_due' }) === true, 'past_due is locked');
assert(isLocked({ subscription_status: 'canceled' }) === true, 'canceled is locked');
assert(isLocked({ subscription_status: 'something_unrecognized' }) === true, 'unrecognized status fails closed (locked)');

// canWrite mirrors isLocked inverse
assert(canWrite({ subscription_status: 'active' }) === true, 'active can write');
assert(canWrite({ subscription_status: 'canceled' }) === false, 'canceled cannot write');

// hasFeature
const basicActive = { plan: 'basic', subscription_status: 'active' };
const proActive = { plan: 'pro', subscription_status: 'active' };
const proLocked = { plan: 'pro', subscription_status: 'canceled' };
assert(hasFeature(basicActive, 'lineBooking') === false, 'basic has no lineBooking');
assert(hasFeature(proActive, 'lineBooking') === true, 'active pro has lineBooking');
assert(hasFeature(proLocked, 'lineBooking') === false, 'locked pro loses all features regardless of plan tier');
assert(hasFeature(basicActive, 'cloudSync') === false, 'basic has no cloudSync');
assert(hasFeature(proActive, 'cloudSync') === true, 'pro has cloudSync');

// clientCapFor
assert(clientCapFor(basicActive) === 15, 'basic client cap is 15');
assert(clientCapFor(proActive) === Infinity, 'pro client cap is unlimited');
assert(clientCapFor({ plan: 'nonsense' }) === 15, 'unknown plan falls back to basic cap');

// trialDaysLeft
assert(trialDaysLeft({ subscription_status: 'active' }) === null, 'active account has no trial days left value');
assert(trialDaysLeft({ subscription_status: 'trialing', trial_ends_at: future(9.4) }) === 10, 'rounds trial days up (9.4 -> 10)');
assert(trialDaysLeft({ subscription_status: 'trialing', trial_ends_at: past(3) }) === 0, 'expired trial floors at 0, never negative');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
