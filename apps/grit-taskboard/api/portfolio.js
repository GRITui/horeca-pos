/* Sidekick — api/portfolio.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `portfolio` IndexedDB store (app/portfolio.js).
 *
 * `created_at` is deliberately left out of FIELDS — see sql/schema-core.sql's
 * note on why it's a server-assigned, update-immune column here.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = ['title', 'description', 'tags', 'image_data_url', 'order_index'];

export default createResourceHandler('portfolio', FIELDS);
export const config = { runtime: 'edge' };
