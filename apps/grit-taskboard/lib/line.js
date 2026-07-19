/* Sidekick — lib/line.js
 *
 * Shared LINE Messaging API helpers, used by both api/line-webhook.js
 * (Step 1: first-contact acknowledgment, triggered by a real inbound
 * message, so it can use the free Reply API) and api/booking-request.js
 * (Step 0: the self-service booking page, which is a plain web form with
 * no LINE replyToken available, so it can only ever push, never reply).
 *
 * Generic multi-tenant (2026-07-14): every function already took channel
 * credentials as parameters rather than reading process.env directly, so
 * the only single-tenant assumption actually baked in here was
 * getLineAccessToken()'s cache being one unkeyed module-level variable —
 * fine when there was only ever one Channel, wrong the moment a second
 * account connects its own. Fixed below (see accessTokenCache). Each
 * account's own credentials now live in the `line_channels` table
 * (sql/schema-core.sql), looked up per-request by the caller — this file
 * still has no idea how many tenants exist, on purpose.
 */
import { constantTimeEqual } from './lineLogin.js';

export async function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqual(expected, signatureHeader);
}

// Keyed by channelId, not a single unkeyed variable — one warm Lambda/edge
// instance now serves however many connected accounts happen to hit it,
// and each needs its own cached token, never another tenant's.
const accessTokenCache = new Map(); // channelId -> { value, expiresAt }
export async function getLineAccessToken(channelId, channelSecret) {
  const cached = accessTokenCache.get(channelId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: channelId,
      client_secret: channelSecret,
    }),
  });
  if (!res.ok) throw new Error(`LINE token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  accessTokenCache.set(channelId, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

// Resolves a channel's own LINE userId (its "bot user ID") — called once at
// connect time (api/line-channel-connect.js) and stored as
// line_channels.bot_user_id, since it never changes for a given channel.
// This is what api/line-webhook.js matches an inbound event's `destination`
// field against to route the one shared webhook URL to the right account.
export async function getLineBotUserId(accessToken) {
  const res = await fetch('https://api.line.me/v2/bot/info', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`LINE bot info fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.userId;
}

// Free — only usable within the response window of a real inbound LINE event.
export async function lineReply(accessToken, replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('LINE reply failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}

// Counts against the Messaging API's monthly quota — proactive, not tied to
// an inbound event. This is the only option for alerting the freelancer
// about a booking that came from the web page, not a LINE message.
export async function linePush(accessToken, toUserId, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!res.ok) console.error('LINE push failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}
