/* Sidekick — api/followups.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `followups` IndexedDB store (app/followups.js) — per-candidate
 * snooze/dismiss decision state, keyed by the client's own `key` string.
 *
 * `created_at` is deliberately left out of FIELDS — see sql/schema-core.sql's
 * note on why it's a server-assigned, update-immune column here.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['key', 'dismissed', 'snoozed_until'];

export default createResourceHandler('followups', FIELDS);
export const config = { runtime: 'edge' };
