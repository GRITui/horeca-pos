/* Sidekick — api/booking-request.js
 *
 * The one write path for the self-service booking page (app/book.html). A
 * client picks a slot and submits this — no chatbot, no LINE message
 * event, which is exactly why the client-side confirmation happens in this
 * response instead of a LINE reply: there is no replyToken to reply with,
 * since nothing was ever sent to LINE.
 *
 * Soft-hold, not instant-confirm and not request-and-wait: the slot is
 * marked 'held' the moment this succeeds (feels immediate to the client),
 * the freelancer gets pushed an alert (if she gave an optional LINE user ID
 * at connect time), and the hold auto-expires if she never confirms — see
 * hold_expires_at in sql/schema-core.sql. The UPDATE below is the actual
 * double-booking guard: a single statement with the current state in its
 * WHERE clause is atomic in Postgres on its own, no explicit transaction
 * needed — two simultaneous requests for the same slot can't both match it.
 *
 * Generic multi-tenant (2026-07-14): requires userCuid in the body,
 * identifying which account's slot/service this request is against — every
 * query below is scoped by it, so one freelancer's public booking page can
 * never touch another's slots. `serviceCuid` (a real Service-catalog cuid,
 * text) replaces the old pilot's own numeric `serviceId`.
 */
import { db } from '../lib/db.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { getLineAccessToken, linePush } from '../lib/line.js';
import { rateLimit } from '../lib/rateLimit.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const HOLD_MINUTES = 15;

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  // Best-effort per-instance rate limit (see lib/rateLimit.js's honest
  // limitation note): public + unauthenticated: a loop can 'hold' every open slot and close the booking page for 15 minutes at a time.
  const limited = rateLimit(request, { key: 'booking-request', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, request);
  }

  const userCuid = typeof body.userCuid === 'string' ? body.userCuid : '';
  const slotId = Number(body.slotId);
  const serviceCuid = typeof body.serviceCuid === 'string' ? body.serviceCuid : '';
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim().slice(0, 100) : '';
  const clientLineUserId = typeof body.clientLineUserId === 'string' ? body.clientLineUserId.slice(0, 100) : null;

  if (!userCuid || !Number.isInteger(slotId) || !serviceCuid || !clientName) {
    return json({ error: 'userCuid, slotId, serviceCuid, and clientName are required' }, 400, request);
  }

  const sql = db();

  let held;
  try {
    held = await sql(
      `update availability_slots
       set status = 'held', hold_expires_at = now() + make_interval(mins => $1)
       where id = $2 and user_cuid = $3
         and (status = 'open' or (status = 'held' and hold_expires_at < now()))
       returning id, starts_at, ends_at`,
      [HOLD_MINUTES, slotId, userCuid]
    );
  } catch (err) {
    console.error('booking-request hold update failed', err.message);
    return json({ error: 'Could not reach the database' }, 502, request);
  }

  if (held.length === 0) {
    return json({ error: 'That slot is no longer available — please pick another.' }, 409, request);
  }
  const slot = held[0];

  try {
    const [service] = await sql(`select cuid, name from services where cuid = $1 and user_cuid = $2`, [serviceCuid, userCuid]);
    if (!service) {
      return json({ error: 'That service is not available.' }, 400, request);
    }
    const [booking] = await sql(
      `insert into bookings (user_cuid, slot_id, service_cuid, client_name, client_line_user_id, status)
       values ($1, $2, $3, $4, $5, 'requested')
       returning id`,
      [userCuid, slotId, serviceCuid, clientName, clientLineUserId]
    );

    // Best-effort — a failed notification shouldn't undo an already-held
    // slot and already-written booking; the freelancer still sees it next
    // time she opens the app either way. Only fires if she gave an
    // optional LINE user ID when connecting her channel (see
    // api/line-channel-connect.js) — booking works fully without it.
    try {
      const [channel] = await sql(
        `select channel_id, channel_secret, freelancer_line_user_id from line_channels where user_cuid = $1`,
        [userCuid]
      );
      if (channel && channel.freelancer_line_user_id) {
        const accessToken = await getLineAccessToken(channel.channel_id, channel.channel_secret);
        await linePush(accessToken, channel.freelancer_line_user_id, [{
          type: 'text',
          text: `New booking request: ${clientName} — ${service.name} — ${new Date(slot.starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })}. Confirm it in Sidekick.`,
        }]);
      }
    } catch (notifyErr) {
      console.error('booking-request notify failed', notifyErr.message);
    }

    return json({ ok: true, bookingId: booking.id, service: service.name, startsAt: slot.starts_at }, 200, request);
  } catch (err) {
    console.error('booking-request handler error', err.message);
    return json({ error: 'Could not complete the booking' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
