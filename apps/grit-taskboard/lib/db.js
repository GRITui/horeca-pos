/* Sidekick — lib/db.js
 *
 * Single shared Neon connection point. Uses @neondatabase/serverless's
 * HTTP-based driver deliberately, not a traditional TCP `pg` client — that's
 * what avoids the connection-pool exhaustion problem a bursty serverless
 * caller would hit against a traditional Postgres (the exact reason a
 * Hostinger-hosted MySQL was ruled out earlier for this piece).
 *
 * Reads DATABASE_URL, the exact env var name Neon's own Vercel integration
 * auto-provisions (pooled connection) — not a name invented here.
 */
import { neon } from '@neondatabase/serverless';

let sql = null;
export function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — connect the Neon integration in the Vercel dashboard first.');
    sql = neon(url);
  }
  return sql;
}
