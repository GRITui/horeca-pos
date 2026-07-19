/* Sidekick — api/auth-register.js
 *
 * Registers a new backend-mode account. The client computes {salt, hash,
 * iters} itself first, using the exact same hashPassword() it already uses
 * for local-only accounts (app.js) — this endpoint never sees a plaintext
 * password, for a brand-new registration exactly as much as for the
 * one-time local->server migration upload (api/migrate-upload.js), which
 * sends the same shape for an *existing* local account's already-computed
 * hash.
 */
import { db } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
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
  // limitation note): account-creation spam is a users-table insert per attempt.
  const limited = rateLimit(request, { key: 'auth-register', limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, request);

  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const { salt, hash, iters, firstName } = body;
  if (username.length < 3) return json({ error: 'Username must be at least 3 characters' }, 400, request);
  if (typeof salt !== 'string' || typeof hash !== 'string' || !Number.isInteger(iters)) {
    return json({ error: 'Missing password hash fields' }, 400, request);
  }

  const sql = db();
  try {
    const cuid = crypto.randomUUID();
    // New accounts start a real 15-day trial (explicit, overriding the
    // users table's own 'active'/no-trial default — that default exists
    // specifically to grandfather pre-existing rows, not to describe a
    // fresh signup). See lib/entitlements.js for how trial_ends_at is
    // read; no Stripe customer/subscription is created at this point —
    // this app doesn't ask for a card until checkout, so there is nothing
    // to create yet.
    const rows = await sql`
      insert into users (cuid, username, password_hash, password_salt, password_iters, first_name, plan, subscription_status, trial_ends_at)
      values (${cuid}, ${username}, ${hash}, ${salt}, ${iters}, ${firstName || null}, 'basic', 'trialing', now() + interval '15 days')
      on conflict (username) do nothing
      returning cuid, username, first_name
    `;
    if (!rows.length) return json({ error: 'That username is already taken' }, 409, request);

    const user = rows[0];
    const token = await signSession({ userCuid: user.cuid }, secret);
    return json({
      token,
      user: { cuid: user.cuid, username: user.username, firstName: user.first_name },
    }, 201, request);
  } catch (err) {
    console.error('auth-register handler error', err.message);
    return json({ error: 'Could not create account' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
