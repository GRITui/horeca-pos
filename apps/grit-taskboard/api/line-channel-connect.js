/* Sidekick — api/line-channel-connect.js
 *
 * Lets an authenticated account connect its own LINE Official Account
 * (a Messaging API channel) for self-service booking — the generic,
 * multi-tenant replacement for the old pilot's single hardcoded Channel.
 * GET returns connection status, POST connects/reconnects, DELETE
 * disconnects. One connected channel per account (1:1) for now.
 *
 * Never returns channel_secret once stored — the account only needs to see
 * it again if they're re-entering it (a fresh POST), never read back.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { getLineAccessToken, getLineBotUserId } from '../lib/line.js';
import { canWrite, hasFeature } from '../lib/entitlements.js';
import { resolveDataOwner } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

// Same fixed-deployment convention app/dataClient.js's API_BASE and
// api/line-webhook.js's LINE_BOOKING_URL fallback already use — overridable
// for local/dev via env, never set in real deployments.
const API_ORIGIN = process.env.API_ORIGIN || 'https://sidekickz.vercel.app';
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://gritui.github.io/Sidekickz';

function connectionUrls(userCuid) {
  return {
    webhookUrl: `${API_ORIGIN}/api/line-webhook`,
    bookingPageUrl: `${APP_ORIGIN}/book.html?u=${encodeURIComponent(userCuid)}`,
  };
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);
  const sql = db();
  // Team members operate on the org owner's channel — same resolution as
  // every crudHandler endpoint; this one predates teams.
  const userCuid = await resolveDataOwner(sql, session.userCuid);

  try {
    // Connecting a channel is plan-gated server-side (the client-side
    // planHasFeature('lineBooking') check alone was bypassable with a bare
    // fetch). DELETE is deliberately auth-only: a locked or downgraded
    // account must always be able to DISCONNECT its channel — holding a
    // credential hostage behind a paywall would be hostile, and removing
    // one reduces our stored-secret surface rather than expanding it.
    if (request.method === 'POST') {
      const [user] = await sql(
        `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
        [userCuid]
      );
      if (!canWrite(user)) return json({ error: 'Subscription required', code: 'locked' }, 402, request);
      if (!hasFeature(user, 'lineBooking')) {
        return json({ error: 'LINE booking needs a Pro or Team plan', code: 'plan' }, 403, request);
      }
    }

    if (request.method === 'GET') {
      const [row] = await sql(
        `select channel_id, bot_user_id, freelancer_line_user_id, connected_at from line_channels where user_cuid = $1`,
        [userCuid]
      );
      if (!row) return json({ connected: false, ...connectionUrls(userCuid) }, 200, request);
      return json({
        connected: true,
        channelId: row.channel_id,
        botUserId: row.bot_user_id,
        freelancerLineUserId: row.freelancer_line_user_id,
        connectedAt: row.connected_at,
        ...connectionUrls(userCuid),
      }, 200, request);
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const channelId = body && typeof body.channelId === 'string' ? body.channelId.trim() : '';
      const channelSecret = body && typeof body.channelSecret === 'string' ? body.channelSecret.trim() : '';
      const freelancerLineUserId = (body && typeof body.freelancerLineUserId === 'string' ? body.freelancerLineUserId.trim() : '') || null;
      if (!channelId || !channelSecret) {
        return json({ error: 'channelId and channelSecret are required' }, 400, request);
      }

      // Validates the credentials against LINE itself — a wrong secret
      // fails the token exchange (401/400 from LINE), which we surface as
      // a clear "couldn't connect" rather than silently storing bad
      // credentials that would only fail later, invisibly, inside a
      // webhook delivery nobody's watching.
      let accessToken, botUserId;
      try {
        accessToken = await getLineAccessToken(channelId, channelSecret);
        botUserId = await getLineBotUserId(accessToken);
      } catch (err) {
        return json({ error: 'Could not verify those LINE credentials — check the Channel ID and Channel secret and try again.' }, 422, request);
      }

      // channel_id has its own unique constraint — this also catches (with
      // a clear error rather than a generic 502) the case of two different
      // Sidekick accounts pasting in the same LINE channel by mistake.
      const rows = await sql(
        `insert into line_channels (user_cuid, channel_id, channel_secret, bot_user_id, freelancer_line_user_id)
         values ($1, $2, $3, $4, $5)
         on conflict (user_cuid) do update set
           channel_id = excluded.channel_id,
           channel_secret = excluded.channel_secret,
           bot_user_id = excluded.bot_user_id,
           freelancer_line_user_id = excluded.freelancer_line_user_id,
           connected_at = now()
         returning channel_id, bot_user_id, freelancer_line_user_id, connected_at`,
        [userCuid, channelId, channelSecret, botUserId, freelancerLineUserId]
      ).catch(err => {
        if (String(err.message || '').includes('line_channels_channel_id_key')) {
          throw Object.assign(new Error('That LINE channel is already connected to a different Sidekick account.'), { code: 'dup_channel' });
        }
        throw err;
      });

      const row = rows[0];
      return json({
        connected: true,
        channelId: row.channel_id,
        botUserId: row.bot_user_id,
        freelancerLineUserId: row.freelancer_line_user_id,
        connectedAt: row.connected_at,
        ...connectionUrls(userCuid),
      }, 200, request);
    }

    if (request.method === 'DELETE') {
      await sql(`delete from line_channels where user_cuid = $1`, [userCuid]);
      return json({ connected: false, ...connectionUrls(userCuid) }, 200, request);
    }

    return json({ error: 'Method not allowed' }, 405, request);
  } catch (err) {
    const message = err && err.code === 'dup_channel' ? err.message : 'Request failed';
    console.error('line-channel-connect handler error', err.message);
    return json({ error: message }, err && err.code === 'dup_channel' ? 409 : 502, request);
  }
}

export const config = { runtime: 'edge' };
