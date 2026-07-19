/* Sidekick — api/packages.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `packages` IndexedDB store (app.js's savePackage()) — prepaid
 * session/unit bundles tracked against a client.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

// 2026-07-16: client_cuid is client_id's ref cuid — see sql/schema-core.sql.
const FIELDS = ['client_id', 'total_sessions', 'price', 'purchased_date', 'expires_at', 'notes', 'client_cuid'];

export default createResourceHandler('packages', FIELDS);
export const config = { runtime: 'edge' };
