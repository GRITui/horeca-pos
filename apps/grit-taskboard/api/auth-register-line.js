/* Sidekick — api/auth-register-line.js
 *
 * Registers (or logs back into) a backend-mode account for a LINE-
 * authenticated local account — the LINE equivalent of api/auth-
 * register.js, needed because a LINE login has no password hash to send
 * that endpoint (see sql/schema-core.sql's users.line_sub comment).
 *
 * api/line-login-callback.js's OAuth exchange is the only place this app
 * ever actually verifies a LINE identity against LINE itself — repeating
 * that whole redirect dance just to click "Enable cloud backup" later
 * would be a jarring, disruptive step for something that should feel like
 * one button click (matching the password-account flow, which reuses an
 * already-computed hash rather than asking to re-enter a password). So
 * instead, that callback mints a signed, long-lived proof of the identity
 * it already verified (lib/lineLogin.js's signLineIdentity()) and hands it
 * to the client to store locally; this endpoint just verifies THAT
 * signature — proving the sub really was checked against LINE at some
 * point — without a fresh OAuth round trip.
 *
 * Unlike api/auth-register.js (which 409s on an existing username, since
 * a plaintext password can't be verified without a real login step), this
 * endpoint can safely treat "the line_sub already has a row" as a normal
 * re-login: the signed token already proves identity as strongly as a
 * password would, so there's nothing left to "log in" with separately.
 */
import { db } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { verifyLineIdentity } from '../lib/lineLogin.js';
import { rateLimit } from '../lib/rateLimit.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  // Best-effort per-instance rate limit (see lib/rateLimit.js's honest
  // limitation note): same account-creation surface as auth-register.
  const limited = rateLimit(request, { key: 'auth-register-line', limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const sessionSecret = process.env.SESSION_SECRET;
  const stateSecret = process.env.LINE_LOGIN_STATE_SECRET;
  if (!sessionSecret || !stateSecret) return json({ error: 'Server misconfigured' }, 500, request);

  const body = await request.json().catch(() => null);
  const lineToken = body && typeof body.lineToken === 'string' ? body.lineToken : null;
  const identity = lineToken ? await verifyLineIdentity(lineToken, stateSecret) : null;
  if (!identity) {
    return json({ error: 'This LINE sign-in has expired — please log out and log back in with LINE, then try again.', code: 'line_identity_invalid' }, 400, request);
  }

  const sql = db();
  try {
    const cuid = crypto.randomUUID();
    const username = 'line:' + identity.sub;
    // First registration: insert a fresh row, same 15-day-trial defaults
    // api/auth-register.js gives a brand-new password account. A repeat
    // "Enable cloud backup" click (or a second device) hits the `on
    // conflict` branch instead — nothing to insert, just refresh the
    // display fields LINE may have changed since the account was created.
    const inserted = await sql`
      insert into users (cuid, username, line_sub, line_picture, first_name, plan, subscription_status, trial_ends_at)
      values (${cuid}, ${username}, ${identity.sub}, ${identity.picture || null}, ${identity.name || null}, 'basic', 'trialing', now() + interval '15 days')
      on conflict (line_sub) do nothing
      returning cuid, username, first_name
    `;
    let user = inserted[0];
    if (!user) {
      const rows = await sql`
        update users set line_picture = ${identity.picture || null}
        where line_sub = ${identity.sub}
        returning cuid, username, first_name
      `;
      user = rows[0];
    }
    if (!user) return json({ error: 'Could not create account' }, 502, request);

    const token = await signSession({ userCuid: user.cuid }, sessionSecret);
    return json({
      token,
      user: { cuid: user.cuid, username: user.username, firstName: user.first_name },
    }, 200, request);
  } catch (err) {
    console.error('auth-register-line handler error', err.message);
    return json({ error: 'Could not create account' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
