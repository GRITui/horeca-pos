/* Sidekick — api/app-bookings.js
 *
 * Phase 2 fan-out of the clients pattern (see api/clients.js) to the
 * `bookings` IndexedDB store (app/bookings.js). Named `app_bookings` /
 * `app-bookings.js` (not the bare `bookings` name) because sql/schema-core.sql's
 * own LINE-integration section already owns an unrelated `bookings` table
 * (self-service client requests against a freelancer's public availability,
 * a different thing entirely from this file's own in-app scheduling) — the
 * names must not collide.
 *
 * `created_at` is deliberately left out of FIELDS — see sql/schema-core.sql's
 * note on why it's a server-assigned, update-immune column here.
 */
import { createResourceHandler } from '../lib/crudHandler.js';

const FIELDS = [
  'customer_id', 'title', 'date', 'start_time', 'duration_min',
  'travel_buffer_min', 'location', 'notes', 'status',
  'job_cuid',
  // 2026-07-16: customer_cuid is customer_id's ref cuid — see sql/schema-core.sql.
  'customer_cuid',
];

export default createResourceHandler('app_bookings', FIELDS);
export const config = { runtime: 'edge' };
