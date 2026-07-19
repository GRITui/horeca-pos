/* Sidekick — api/booking-requests.js
 *
 * The freelancer's side of the self-service booking flow — the missing
 * half of api/booking-request.js (public, singular): that endpoint creates
 * bookings as status='requested' with a 15-minute slot hold, and until now
 * nothing could ever move one to 'confirmed'/'declined' or flip the slot
 * to 'booked'. GET lists the account's pending requests; POST confirms or
 * declines one.
 *
 * Confirm uses a single atomic conditional UPDATE on the slot — the same
 * technique api/booking-request.js's hold uses, for the same reason: two
 * 'requested' bookings can exist against one slot (a hold expires after 15
 * minutes and a second client can re-grab it, but the first booking row
 * stays 'requested'). If the freelancer confirms both, only one can win.
 * `where ... status in ('held','open')` makes the first confirm flip the
 * slot to 'booked' and the second match zero rows → 409 slot_taken, with
 * that booking left 'requested' so it can still be declined cleanly. No
 * explicit transaction needed — one UPDATE with the current state in its
 * WHERE clause is atomic in Postgres on its own. ('open' is included
 * because an expired hold that nobody re-grabbed is still confirmable —
 * the client asked, the freelancer said yes, the slot is free.)
 *
 * Decline releases the slot back to 'open' ONLY from 'held' — never from
 * 'booked', which would silently un-book whichever other request won it.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { canWrite } from '../lib/entitlements.js';
import { resolveDataOwner } from '../lib/teams.js';
import { getLineAccessToken, linePush } from '../lib/line.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

// Factory shape so tests can swap in an in-memory fake sql without a live
// Neon connection — same opts.getSql seam lib/crudHandler.js established
// (see tests/test-booking-confirm.mjs).
export function createBookingRequestsHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);

    const sql = getSql();
    // A team member (admin/staff) manages the org owner's booking requests,
    // same data-owner resolution as lib/crudHandler.js.
    const owner = await resolveDataOwner(sql, session.userCuid);

    try {
      if (request.method === 'GET') {
        // hold_expired is computed against the DB clock (same clock the
        // hold itself was written with) rather than re-parsing timestamps
        // here: true when the 15-minute hold has lapsed (or the slot went
        // back to 'open'), so the UI can warn "this slot may have been
        // re-requested".
        const rows = await sql(
          `select b.id, b.slot_id, b.client_name, b.created_at,
                  s.starts_at, s.ends_at,
                  (s.status = 'open' or (s.status = 'held' and s.hold_expires_at < now())) as hold_expired,
                  sv.name as service_name
           from bookings b
           join availability_slots s on s.id = b.slot_id
           left join services sv on sv.cuid = b.service_cuid
           where b.user_cuid = $1 and b.status = 'requested'
           order by b.created_at desc`,
          [owner]
        );
        return json({
          rows: rows.map(r => ({
            id: r.id,
            slotId: r.slot_id,
            clientName: r.client_name,
            serviceName: r.service_name,
            startsAt: r.starts_at,
            endsAt: r.ends_at,
            holdExpired: !!r.hold_expired,
            createdAt: r.created_at,
          })),
        }, 200, request);
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const bookingId = body ? Number(body.bookingId) : NaN;
        const action = body && body.action;
        if (!Number.isInteger(bookingId) || (action !== 'confirm' && action !== 'decline')) {
          return json({ error: "bookingId and action ('confirm' or 'decline') are required" }, 400, request);
        }

        // Same write-lock gate as lib/crudHandler.js, checked against the
        // resolved data owner: a locked account is read-only.
        const [user] = await sql(
          `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
          [owner]
        );
        if (!canWrite(user)) {
          return json({ error: 'Subscription required', code: 'locked' }, 402, request);
        }

        const [booking] = await sql(
          `select b.id, b.slot_id, b.client_line_user_id, b.client_name, sv.name as service_name
           from bookings b
           left join services sv on sv.cuid = b.service_cuid
           where b.id = $1 and b.user_cuid = $2 and b.status = 'requested'`,
          [bookingId, owner]
        );
        if (!booking) return json({ error: 'Not found' }, 404, request);

        if (action === 'confirm') {
          // The atomic winner-takes-the-slot update — see header comment.
          const bookedRows = await sql(
            `update availability_slots
             set status = 'booked', hold_expires_at = null
             where id = $1 and user_cuid = $2 and status in ('held', 'open')
             returning id, starts_at`,
            [booking.slot_id, owner]
          );
          if (bookedRows.length === 0) {
            // Another request already booked this slot; this booking stays
            // 'requested' so the freelancer can decline it explicitly.
            return json({ error: 'That slot was already booked by another confirmed request.', code: 'slot_taken' }, 409, request);
          }

          await sql(`update bookings set status = 'confirmed' where id = $1`, [bookingId]);

          // Best-effort LINE push to the CLIENT — mirror of the freelancer
          // notification in api/booking-request.js: a failed push never
          // undoes an already-booked slot, and it only fires when the
          // client arrived via LINE (client_line_user_id set) AND the
          // account has a connected channel to push through.
          try {
            if (booking.client_line_user_id) {
              const [channel] = await sql(
                `select channel_id, channel_secret from line_channels where user_cuid = $1`,
                [owner]
              );
              if (channel) {
                const accessToken = await getLineAccessToken(channel.channel_id, channel.channel_secret);
                await linePush(accessToken, booking.client_line_user_id, [{
                  type: 'text',
                  text: `Your booking is confirmed: ${booking.service_name || 'appointment'} — ${new Date(bookedRows[0].starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })}. See you then!`,
                }]);
              }
            }
          } catch (notifyErr) {
            console.error('booking-requests notify failed', notifyErr.message);
          }

          return json({ ok: true, status: 'confirmed' }, 200, request);
        }

        // action === 'decline'
        await sql(`update bookings set status = 'declined' where id = $1`, [bookingId]);
        // Release the slot back to the pool ONLY from 'held' — a 'booked'
        // slot belongs to whichever other request won it (header comment).
        await sql(
          `update availability_slots
           set status = 'open', hold_expires_at = null
           where id = $1 and user_cuid = $2 and status = 'held'`,
          [booking.slot_id, owner]
        );
        return json({ ok: true, status: 'declined' }, 200, request);
      }

      return json({ error: 'Method not allowed' }, 405, request);
    } catch (err) {
      console.error('booking-requests handler error', err.message);
      return json({ error: 'Request failed' }, 502, request);
    }
  };
}

export default createBookingRequestsHandler();
export const config = { runtime: 'edge' };
