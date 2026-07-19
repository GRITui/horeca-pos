/* Sidekick — api/clients.js
 *
 * Phase 1 of the local-first -> backend migration: the one representative
 * data resource proving the auth + CRUD + row-scoping pattern end-to-end
 * before it's fanned out to the other 13 IndexedDB stores (see the project
 * plan). GET (list) / POST (create) / PUT+DELETE (via ?cuid=) — see
 * lib/crudHandler.js for what every verb actually does.
 *
 * The one resource with a per-plan quantity cap: Basic is limited to
 * clientCapFor() clients (15 today — lib/entitlements.js PLAN_FEATURES).
 * The client-side gate (app.js planClientCap()) alone was bypassable with
 * a bare fetch, so the cap is enforced here too via crudHandler's
 * beforeCreate hook — counted against the resolved data owner, same as
 * every other entitlement check. Updates/deletes are never capped: an
 * over-cap account (e.g. downgraded from Pro) keeps full access to the
 * clients it already has, it just can't add more.
 */
import { createResourceHandler } from '../lib/crudHandler.js';
import { clientCapFor } from '../lib/entitlements.js';

const FIELDS = ['name', 'phone', 'email', 'tags', 'notes', 'tax_id', 'billing_address', 'member_no'];

async function enforceClientCap(sql, ownerCuid, ownerRow) {
  const cap = clientCapFor(ownerRow);
  if (!Number.isFinite(cap)) return null;
  const [{ count }] = await sql(
    `select count(*)::int as count from clients where user_cuid = $1`,
    [ownerCuid]
  );
  if (count >= cap) {
    return new Response(
      JSON.stringify({ error: 'Client limit reached — upgrade to add more', code: 'client_cap' }),
      { status: 402, headers: { 'content-type': 'application/json' } }
    );
  }
  return null;
}

export default createResourceHandler('clients', FIELDS, { beforeCreate: enforceClientCap });
export const config = { runtime: 'edge' };
