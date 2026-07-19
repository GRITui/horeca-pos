/* Sidekick — api/auth-session.js
 *
 * "Whoami" for the bearer token app/dataClient.js holds — used at boot to
 * confirm the stored token is still valid and to refresh the user's
 * profile fields (firstName etc.) without requiring a fresh login. Logout
 * is stateless by design (no server-side session store): the client just
 * discards its token, matching how session teardown already works for
 * local accounts (`localStorage.removeItem(SESSION_KEY)`).
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { isLocked, trialDaysLeft, hasFeature, clientCapFor, FEATURE_KEYS } from '../lib/entitlements.js';
import { getMembership } from '../lib/teams.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const sql = db();
  try {
    const rows = await sql`
      select cuid, username, first_name, migrated_at from users where cuid = ${session.userCuid}
    `;
    const caller = rows[0];
    if (!caller) return json({ error: 'Not authenticated' }, 401, request);

    // Team (Phase 2): entitlements (plan/status/features/lock) always come
    // from the DATA OWNER's row, not the caller's own — a staff member
    // operates under the org owner's plan, never their own. `team` reports
    // the caller's own relationship to that: which account owns the org
    // they're a member of (if any), or, if they're not a member of
    // anyone's team, whether their OWN account is itself a team owner
    // (plan === 'team', true from the moment they're on that plan — an
    // owner with zero members invited yet is still an owner) plus current
    // seat usage for that case.
    const membership = await getMembership(sql, caller.cuid);
    const ownerCuid = membership ? membership.orgOwnerCuid : caller.cuid;
    const ownerRows = membership
      ? await sql`select plan, subscription_status, trial_ends_at, current_period_end, stripe_customer_id, team_seats, first_name, username from users where cuid = ${ownerCuid}`
      : await sql`select plan, subscription_status, trial_ends_at, current_period_end, stripe_customer_id, team_seats from users where cuid = ${ownerCuid}`;
    const owner = ownerRows[0];
    if (!owner) return json({ error: 'Not authenticated' }, 401, request);

    const features = {};
    for (const key of FEATURE_KEYS) features[key] = hasFeature(owner, key);
    const cap = clientCapFor(owner);

    let team = null;
    if (membership) {
      team = { role: membership.role, isOwner: false, orgOwnerName: owner.first_name || owner.username };
    } else if (owner.plan === 'team') {
      const memberRows = await sql`select cuid from team_members where org_owner_cuid = ${caller.cuid}`;
      team = { role: 'owner', isOwner: true, seats: owner.team_seats || null, memberCount: memberRows.length };
    }

    return json({
      user: {
        cuid: caller.cuid,
        username: caller.username,
        firstName: caller.first_name,
        migrated: caller.migrated_at != null,
        plan: owner.plan,
        subscriptionStatus: owner.subscription_status,
        trialEndsAt: owner.trial_ends_at,
        currentPeriodEnd: owner.current_period_end,
        trialDaysLeft: trialDaysLeft(owner),
        locked: isLocked(owner),
        hasStripeCustomer: owner.stripe_customer_id != null,
        features,
        // null = unlimited (JSON has no Infinity) — the client treats a
        // missing/null cap as "don't block."
        clientCap: cap === Infinity ? null : cap,
        team,
      },
    }, 200, request);
  } catch (err) {
    console.error('auth-session handler error', err.message);
    return json({ error: 'Could not load session' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
