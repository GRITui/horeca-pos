process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_local_harness';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';

import Stripe from 'stripe';
import { verifyStripeWebhook } from '../lib/stripe.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const secret = process.env.STRIPE_WEBHOOK_SECRET;
const payload = JSON.stringify({
  id: 'evt_test_1',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_123', customer: 'cus_123', status: 'active', current_period_end: 1999999999, metadata: { plan: 'pro', userCuid: 'user-abc' } } },
});

const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });

try {
  const event = await verifyStripeWebhook(payload, header, secret);
  assert(event.type === 'customer.subscription.updated', 'valid signature verifies and returns the parsed event');
} catch (err) {
  fail++; console.log('FAIL: valid signature should verify, got error:', err.message);
}

try {
  await verifyStripeWebhook(payload, header, 'whsec_wrong_secret');
  fail++; console.log('FAIL: wrong secret should have thrown');
} catch (err) {
  pass++;
}

try {
  const tamperedPayload = payload.replace('"active"', '"canceled"');
  await verifyStripeWebhook(tamperedPayload, header, secret);
  fail++; console.log('FAIL: tampered payload should have thrown');
} catch (err) {
  pass++;
}

try {
  await verifyStripeWebhook(payload, 'not-a-real-signature-header', secret);
  fail++; console.log('FAIL: malformed signature header should have thrown');
} catch (err) {
  pass++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
