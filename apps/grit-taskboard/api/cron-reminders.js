/* Sidekick — api/cron-reminders.js
 *
 * T-24h LINE booking reminders (Pass M2c). A client who booked through a
 * freelancer's public booking page (app/book.html) and arrived via LINE
 * (client_line_user_id set) gets one automatic LINE push roughly a day
 * before their CONFIRMED appointment. Vercel Cron hits this endpoint once
 * an hour (vercel.json) — there is no per-booking scheduling, just a
 * recurring sweep for anything that has entered the 24h window and hasn't
 * been reminded yet.
 *
 * Idempotency: `bookings.reminder_sent_at` (sql/schema-core.sql) is the
 * only source of truth. It is stamped ONLY after a push actually succeeds,
 * so a failed push (LINE API hiccup, bad token, etc.) just leaves the row
 * NULL for the next hourly run to retry — never a silent drop, never a
 * double-send. Bookings whose start time has already passed permanently
 * fall out of the query's `starts_at > now()` bound: this is deliberate,
 * not a bug — nobody should ever get a "reminder" for a meeting that's
 * already happened, so a missed window just means no reminder, not a
 * late one.
 *
 * SECURITY: same convention as api/admin-migrate.js's SETUP_TOKEN. Disabled
 * (404) unless CRON_SECRET is set; Vercel Cron sends it back automatically
 * as `Authorization: Bearer <CRON_SECRET>` on every invocation once the env
 * var exists on the project (see .env.example) — no header configuration
 * needed on the Vercel Cron side itself. A request with the header present
 * but wrong gets 403 (constant-time compare, reusing lib/lineLogin.js's
 * constantTimeEqual — the same helper api/admin-migrate.js reuses).
 *
 * Factory shape mirrors api/booking-requests.js's createBookingRequestsHandler:
 * `getSql` swaps in an in-memory fake for tests; `push` swaps in a fake LINE
 * push for tests that don't want to stub globalThis.fetch. Both default to
 * the real thing.
 */
import { db } from '../lib/db.js';
import { constantTimeEqual } from '../lib/lineLogin.js';
import { getLineAccessToken, linePush } from '../lib/line.js';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FALLBACK_SERVICE_NAME = 'นัดหมาย / appointment';

// Same date/time presentation convention api/booking-requests.js's confirm
// push already uses (en-GB + explicit Asia/Bangkok timeZone) — kept as two
// separate formatters (date vs time) since the message template places them
// in different spots of both the Thai and English lines.
function formatBangkok(startsAt) {
  const d = new Date(startsAt);
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return { date, time };
}

// No "tomorrow"/"พรุ่งนี้" wording on purpose: the hourly sweep can catch a
// booking made (or first swept) only hours before it starts, and the
// explicit date already says when. Owner suffix is dropped entirely when
// the account has no display name — "กับ " with nothing after it reads
// broken in both languages.
function reminderText({ date, time, serviceName, ownerName }) {
  const service = serviceName || FALLBACK_SERVICE_NAME;
  const thOwner = ownerName ? ` กับ ${ownerName}` : '';
  const enOwner = ownerName ? ` with ${ownerName}` : '';
  return (
    `แจ้งเตือนนัดหมาย: ${date} เวลา ${time} น. — ${service}${thOwner}\n` +
    `Reminder: your appointment on ${date} at ${time} — ${service}${enOwner}`
  );
}

export function createCronRemindersHandler(opts = {}) {
  const getSql = opts.getSql || db;
  const push = opts.push || linePush;

  return async function handler(request) {
    const secret = process.env.CRON_SECRET;
    // Unset secret = endpoint doesn't exist, effectively — same posture as
    // SETUP_TOKEN in api/admin-migrate.js. This also makes the hourly cron
    // schedule a harmless no-op until the operator opts in (see
    // .env.example): reminders are OFF by default.
    if (!secret) return json({ error: 'Not found' }, 404);

    const authHeader = request.headers.get('authorization') || '';
    const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!constantTimeEqual(supplied, secret)) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Vercel Cron invokes with GET.
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let due = 0, sent = 0, failed = 0;

    try {
      const sql = getSql();

      // Confirmed, LINE-originated, not-yet-reminded bookings starting
      // within the next 24h. `starts_at > now()` is the deliberate "never
      // remind about the past" bound described in the header comment.
      const rows = await sql(
        `select b.id, b.user_cuid, b.client_name, b.client_line_user_id, s.starts_at, s.ends_at, sv.name as service_name
         from bookings b
         join availability_slots s on s.id = b.slot_id
         left join services sv on sv.cuid = b.service_cuid
         where b.status = 'confirmed' and b.client_line_user_id is not null
           and b.reminder_sent_at is null
           and s.starts_at > now() and s.starts_at <= now() + interval '24 hours'`,
        []
      );
      due = rows.length;

      // Group by account so each connected LINE channel's access token is
      // fetched (and cached by lib/line.js) exactly once per run, not once
      // per booking — mirrors the per-account token lookup
      // api/booking-requests.js's confirm push already does.
      const byOwner = new Map();
      for (const row of rows) {
        if (!byOwner.has(row.user_cuid)) byOwner.set(row.user_cuid, []);
        byOwner.get(row.user_cuid).push(row);
      }

      for (const [ownerCuid, ownerRows] of byOwner) {
        let accessToken, ownerName;
        try {
          const [channel] = await sql(
            `select channel_id, channel_secret from line_channels where user_cuid = $1`,
            [ownerCuid]
          );
          if (!channel) {
            // No connected LINE channel (disconnected since the booking was
            // made, or never set up) — skip every row for this account,
            // unstamped, and log once rather than once per row.
            console.error('cron-reminders: no line_channels row for account, skipping', ownerRows.length, 'booking(s)');
            continue;
          }
          const [owner] = await sql(`select first_name, username from users where cuid = $1`, [ownerCuid]);
          ownerName = (owner && (owner.first_name || owner.username)) || '';
          accessToken = await getLineAccessToken(channel.channel_id, channel.channel_secret);
        } catch (err) {
          console.error('cron-reminders: channel/token resolution failed', err.message);
          continue;
        }

        for (const row of ownerRows) {
          const { date, time } = formatBangkok(row.starts_at);
          const text = reminderText({ date, time, serviceName: row.service_name, ownerName });
          try {
            const ok = await push(accessToken, row.client_line_user_id, [{ type: 'text', text }]);
            if (ok) {
              await sql(`update bookings set reminder_sent_at = now() where id = $1`, [row.id]);
              sent++;
            } else {
              failed++;
              console.error('cron-reminders: push failed for booking id', row.id);
            }
          } catch (err) {
            failed++;
            console.error('cron-reminders: push threw for booking id', row.id, err.message);
          }
        }
      }

      // Counts only — never client names/ids/tokens in the response body.
      return json({ ok: true, due, sent, failed }, 200);
    } catch (err) {
      console.error('cron-reminders handler error', err.message);
      return json({ error: 'Request failed' }, 502);
    }
  };
}

export default createCronRemindersHandler();
export const config = { runtime: 'edge' };
