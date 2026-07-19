/* Sidekick — api/line-webhook.js (LINE integration, Step 1: first-contact acknowledgment)
 *
 * Receives LINE Messaging API webhook events and replies to a user's first
 * message with a canned link to that specific freelancer's booking page.
 *
 * Generic multi-tenant (2026-07-14): ONE shared webhook URL now serves
 * every connected account — LINE's webhook payload always carries a
 * `destination` field (the receiving bot's own LINE userId), which is
 * matched against line_channels.bot_user_id (sql/schema-core.sql) to find
 * which account this delivery belongs to, before doing anything else with
 * it. This is safe to do BEFORE signature verification: worst case an
 * attacker fabricates a body with someone else's real destination, but the
 * signature check right after still fails (they don't have that account's
 * channel_secret) and the request is rejected — destination only ever
 * selects *whose* secret to check against, it's never trusted on its own.
 * A destination matching no connected account acks 200 and does nothing,
 * rather than a 404/401 that would tell a prober anything about which
 * destinations are or aren't connected.
 *
 * Written as a Web API (Request/Response) handler rather than a classic
 * Vercel (req, res) handler. That's deliberate: verifying LINE's webhook
 * signature requires hashing the exact raw bytes of the request body, and
 * Vercel's Node (req, res) helper for plain (non-Next.js) functions has
 * documented rough edges exposing that raw body. The Request/Response
 * signature gives a reliable `await request.text()` for the untouched raw
 * body instead.
 *
 * NOT YET LIVE-TESTED — this repo has no Vercel deploy access from this
 * session, so this has only been checked against LINE's documented request/
 * response shapes and a local HMAC unit check (see session notes), not
 * exercised against a real webhook delivery.
 */
import { db } from '../lib/db.js';
import { verifyLineSignature, getLineAccessToken, lineReply } from '../lib/line.js';

const APP_ORIGIN = process.env.APP_ORIGIN || 'https://gritui.github.io/Sidekickz';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const rawBody = await request.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const destination = typeof body.destination === 'string' ? body.destination : null;
  if (!destination) return new Response(JSON.stringify({ ok: true }), { status: 200 });

  const sql = db();
  let channel;
  try {
    const rows = await sql(`select user_cuid, channel_id, channel_secret from line_channels where bot_user_id = $1`, [destination]);
    channel = rows[0];
  } catch (err) {
    console.error('line-webhook channel lookup failed', err.message);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (!channel) return new Response(JSON.stringify({ ok: true }), { status: 200 });

  const signature = request.headers.get('x-line-signature');
  if (!(await verifyLineSignature(rawBody, signature, channel.channel_secret))) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  const bookingUrl = `${APP_ORIGIN}/book.html?u=${encodeURIComponent(channel.user_cuid)}`;
  const events = Array.isArray(body.events) ? body.events : [];
  try {
    if (events.some(e => e.type === 'message' && e.replyToken)) {
      const accessToken = await getLineAccessToken(channel.channel_id, channel.channel_secret);
      for (const event of events) {
        if (event.type === 'message' && event.replyToken) {
          await lineReply(accessToken, event.replyToken, [{
            type: 'text',
            text: `Thanks for reaching out! Here's my services & open times — book a slot any time:\n${bookingUrl}`,
          }]);
        }
      }
    }
  } catch (err) {
    // LINE expects a fast 200 regardless, or it retries the whole batch —
    // log and acknowledge rather than fail the delivery.
    console.error('line-webhook handler error', err);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

export const config = { runtime: 'edge' };
