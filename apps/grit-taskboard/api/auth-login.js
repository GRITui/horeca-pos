/* Sidekick — api/auth-login.js
 *
 * Sends the plaintext password once, over HTTPS, straight to this endpoint
 * — deliberately not a two-step "fetch my salt, hash locally, then submit"
 * dance the way the local-only app effectively got for free (a local
 * IndexedDB lookup has no network round trip to protect). Once a real
 * network hop exists at all, a single request verified server-side is
 * simpler and sidesteps a username-enumeration timing side-channel a
 * separate salt-lookup endpoint would need its own defenses against. See
 * lib/auth.js's header for the full reasoning.
 */
import { db } from '../lib/db.js';
import { signSession, verifyPassword } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { rateLimit } from '../lib/rateLimit.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const GENERIC_FAIL = { error: 'Incorrect username or password' };

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  // Best-effort per-instance rate limit (see lib/rateLimit.js's honest
  // limitation note): credential stuffing costs a DB lookup + PBKDF2 verify per attempt.
  const limited = rateLimit(request, { key: 'auth-login', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

  const body = await request.json().catch(() => null);
  const username = body && typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return json(GENERIC_FAIL, 401, request);

  const sql = db();
  try {
    const rows = await sql`
      select cuid, username, first_name, password_hash, password_salt, password_iters
      from users where username = ${username}
    `;
    const user = rows[0];
    // A LINE-only account has password_hash === null — same generic failure,
    // never revealing which case it was.
    if (!user || !user.password_hash) return json(GENERIC_FAIL, 401, request);

    const ok = await verifyPassword(password, {
      salt: user.password_salt, hash: user.password_hash, iters: user.password_iters,
    });
    if (!ok) return json(GENERIC_FAIL, 401, request);

    const token = await signSession({ userCuid: user.cuid }, secret);
    return json({
      token,
      user: { cuid: user.cuid, username: user.username, firstName: user.first_name },
    }, 200, request);
  } catch (err) {
    console.error('auth-login handler error', err.message);
    return json({ error: 'Could not log in' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
