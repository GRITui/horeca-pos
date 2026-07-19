/* Sidekick — api/invoices.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `invoices` IndexedDB store. lineItems and the issue-time paymentChannels
 * snapshot are embedded arrays on the invoice record in the client today —
 * mirrored here as JSONB columns (sql/schema-core.sql has the rationale).
 *
 * Not to be confused with app/invoices.js (the client-side module) — this
 * is the API-layer counterpart, a different file in a different directory.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'number', 'issue_date', 'due_date', 'client_id', 'client_name', 'client_tax_id',
  'client_address', 'line_items', 'subtotal', 'wht_pct', 'vat_pct', 'vat', 'wht',
  'client_pays', 'you_receive', 'deposit_pct', 'status', 'payment_channels', 'notes',
  // 2026-07-16: ref cuid for client_id — see sql/schema-core.sql.
  'client_cuid',
  // 2026-07-17: embedded payment-slip array (Pass M2a) — see sql/schema-core.sql.
  'slips',
  // 2026-07-17: Pass M3-L1 — double-decrement guard stamp for product stock
  // (app.js decrementStockForInvoicePaid); see sql/schema-core.sql.
  'stock_decremented_at',
];

export default createResourceHandler('invoices', FIELDS);
export const config = { runtime: 'edge' };
