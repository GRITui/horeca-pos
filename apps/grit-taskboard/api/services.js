/* Sidekick — api/services.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `services` IndexedDB store, including the usageQty/rate/unit fields.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

// 2026-07-17: Pass M3-L1 — unify Services into a product/service catalog
// (kind='service'|'product', sku, stock_qty, cost). See sql/schema-core.sql.
const FIELDS = ['name', 'rate', 'unit', 'usage_qty', 'kind', 'sku', 'stock_qty', 'cost'];

export default createResourceHandler('services', FIELDS);
export const config = { runtime: 'edge' };
