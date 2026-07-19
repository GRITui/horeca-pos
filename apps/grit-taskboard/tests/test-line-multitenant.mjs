import { verifyLineSignature, getLineAccessToken, getLineBotUserId } from '../lib/line.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── Mock global fetch to simulate LINE's token-exchange + bot-info
// endpoints for TWO distinct channels, so we can prove the token cache
// (lib/line.js's accessTokenCache) is keyed per-channel and never
// cross-contaminates a different tenant's token.
const tokenCalls = [];
const botInfoCalls = [];
global.fetch = async (url, opts) => {
  if (String(url).includes('oauth/accessToken')) {
    const params = new URLSearchParams(opts.body);
    const clientId = params.get('client_id');
    tokenCalls.push(clientId);
    return {
      ok: true,
      json: async () => ({ access_token: 'token-for-' + clientId, expires_in: 1800 }),
    };
  }
  if (String(url).includes('/v2/bot/info')) {
    const auth = opts.headers.authorization; // "Bearer token-for-<clientId>"
    botInfoCalls.push(auth);
    const token = auth.replace('Bearer ', '');
    return {
      ok: true,
      json: async () => ({ userId: 'U_bot_for_' + token }),
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

const tokenA = await getLineAccessToken('channel-A', 'secretA');
const tokenB = await getLineAccessToken('channel-B', 'secretB');
assert(tokenA === 'token-for-channel-A', 'channel A gets its own token, got ' + tokenA);
assert(tokenB === 'token-for-channel-B', 'channel B gets its own token, got ' + tokenB);
assert(tokenA !== tokenB, 'two different channels never share a token');

// Second call for channel A should hit the cache, not fetch again.
tokenCalls.length = 0;
const tokenAagain = await getLineAccessToken('channel-A', 'secretA');
assert(tokenAagain === tokenA, 'cached token returned on second call');
assert(tokenCalls.length === 0, 'no new token-exchange fetch fired for an already-cached channel, calls=' + tokenCalls.length);

const botA = await getLineBotUserId(tokenA);
const botB = await getLineBotUserId(tokenB);
assert(botA === 'U_bot_for_token-for-channel-A', 'bot info resolves the right bot userId for channel A, got ' + botA);
assert(botB === 'U_bot_for_token-for-channel-B', 'bot info resolves the right bot userId for channel B, got ' + botB);
assert(botA !== botB, 'two different channels resolve to different bot userIds');

// ── Signature verification: unchanged behavior, still per-secret correct
// (the multi-tenant webhook now looks up a tenant's secret before calling
// this — this just confirms the primitive itself still behaves).
const rawBody = JSON.stringify({ destination: 'U_bot_for_token-for-channel-A', events: [] });
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secretA'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
const validSig = btoa(String.fromCharCode(...new Uint8Array(mac)));

assert(await verifyLineSignature(rawBody, validSig, 'secretA') === true, 'valid signature against the right secret verifies');
assert(await verifyLineSignature(rawBody, validSig, 'secretB') === false, 'valid signature against a DIFFERENT tenant\'s secret is rejected — this is what stops a spoofed destination from routing to another tenant\'s handler');
assert(await verifyLineSignature(rawBody, 'garbage', 'secretA') === false, 'malformed signature rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
