/* Sidekick — api/research.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `research` IndexedDB store (app/research.js) — the content-library
 * articles a freelancer can author for their own clients.
 *
 * `created_at` is deliberately left out of FIELDS — see sql/schema-core.sql's
 * note on why it's a server-assigned, update-immune column here.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['title', 'category', 'body', 'is_premium'];

export default createResourceHandler('research', FIELDS);
export const config = { runtime: 'edge' };
