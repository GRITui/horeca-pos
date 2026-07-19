/* Sidekick — api/jobs.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the `jobs`
 * IndexedDB store. subTasks/milestones/timeEntries/stageOrder are embedded
 * arrays on the job record itself in the client today — mirrored here as
 * JSONB columns rather than normalized into child tables (sql/schema-core.sql
 * has the full rationale).
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'date', 'client_name', 'client_id', 'service_id', 'service_name', 'job_type',
  'amount', 'tip', 'expense', 'count', 'notes', 'net_amount',
  'stage_order', 'stage', 'complete', 'invoice_id', 'quote_doc_id', 'package_id',
  'sub_tasks', 'milestones', 'time_entries', 'timer_started_at',
  // 2026-07-17: restore-fidelity fix — these were missing from the mirror,
  // so a lost job restored from cloud silently came back as outcome=null.
  'outcome', 'lost_reason', 'pending_gate_stage', 'options',
  // 2026-07-17: Pass M3-L2 — products/extra services attached to a pipeline
  // engagement, flowing into the quote + invoice as linked line items.
  'items',
  // 2026-07-16: ref cuids alongside each id-ref above — see sql/schema-core.sql
  // for the restore/team-pull link-fidelity rationale.
  'client_cuid', 'service_cuid', 'invoice_cuid', 'quote_doc_cuid', 'package_cuid',
];

export default createResourceHandler('jobs', FIELDS);
export const config = { runtime: 'edge' };
