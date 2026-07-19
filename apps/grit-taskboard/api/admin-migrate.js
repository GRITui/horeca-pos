/* Sidekick — api/admin-migrate.js
 *
 * One-time setup endpoint that applies sql/schema-core.sql through the
 * app's own DATABASE_URL. Exists to kill a real operational trap: the
 * Vercel project has had TWO Neon databases attached, and a hand-run
 * `psql -f schema-core.sql` against the wrong one looks successful while
 * leaving every server feature broken (the 2026-07-13 incident). Running
 * the migration through this endpoint makes wrong-database impossible —
 * it can only ever touch the database the deployed code actually reads.
 *
 * SECURITY: disabled unless the SETUP_TOKEN env var is set, and every
 * request must carry it in the x-setup-token header (constant-time
 * compare). Intended use: set SETUP_TOKEN in Vercel → redeploy → curl the
 * endpoint once → REMOVE the env var (re-disabling the endpoint). DDL
 * behind a bearer-style secret is acceptable for a one-shot setup tool
 * precisely because the SQL is idempotent and additive-only (the schema
 * file's own convention — no drops, no data mutations).
 *
 *   status: curl https://<api>/api/admin-migrate -H "x-setup-token: $T"
 *   apply : curl -X POST (same URL/header)
 *
 * GET reports which required tables/columns are missing (and the database
 * NAME — never the connection string) so "did it land?" is answerable in
 * one call. POST applies every statement and returns the same status
 * afterward, plus per-statement errors if any.
 */
import { db } from '../lib/db.js';
import { constantTimeEqual } from '../lib/lineLogin.js';
import { SCHEMA_SQL } from '../lib/schemaSql.js';
import { splitSqlStatements, schemaStatus, runMigration } from '../lib/migrate.js';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(request) {
  const token = process.env.SETUP_TOKEN;
  // Unset token = endpoint doesn't exist, effectively. 404 (not 403) so an
  // unconfigured deployment reveals nothing about this route's purpose.
  if (!token) return json({ error: 'Not found' }, 404);

  const supplied = request.headers.get('x-setup-token') || '';
  if (!constantTimeEqual(supplied, token)) {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const sql = db();   // throws if DATABASE_URL is unset — that's a 502, not a crash
    if (request.method === 'GET') {
      return json(await schemaStatus(sql), 200);
    }
    if (request.method === 'POST') {
      const statements = splitSqlStatements(SCHEMA_SQL);
      const result = await runMigration(sql, statements);
      const status = await schemaStatus(sql);
      return json({ ...result, status }, result.errors.length ? 207 : 200);
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('admin-migrate error', err.message);
    return json({ error: 'Migration request failed' }, 502);
  }
}

export const config = { runtime: 'edge' };
