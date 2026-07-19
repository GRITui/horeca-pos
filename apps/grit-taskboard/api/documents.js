/* Sidekick — api/documents.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `documents` IndexedDB store (app/docgen.js). The per-doc-type `fields`
 * object is mirrored here as a JSONB column (sql/schema-core.sql has the
 * rationale).
 */
import { createResourceHandler } from '../lib/crudHandler.js';

// 2026-07-16: client_cuid/invoice_cuid are ref cuids for client_id/invoice_id
// — see sql/schema-core.sql.
const FIELDS = ['type', 'title', 'client_id', 'client_name', 'invoice_id', 'fields', 'content', 'number', 'issue_date', 'client_cuid', 'invoice_cuid'];

export default createResourceHandler('documents', FIELDS);
export const config = { runtime: 'edge' };
