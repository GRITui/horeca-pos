/* Sidekick — lib/migrate.js
 *
 * Applies sql/schema-core.sql (embedded verbatim in lib/schemaSql.js)
 * through the app's own DATABASE_URL — see api/admin-migrate.js for why
 * this exists (the wrong-Neon-database trap). Neon's HTTP driver executes
 * ONE statement per call, so the file is split into statements first.
 *
 * The splitter is deliberately minimal but must respect two things the
 * schema file actually contains:
 *   - `--` line comments (stripped; the file has none inside string
 *     literals, and none of its DDL carries `--` inside quotes)
 *   - one dollar-quoted `do $$ ... end $$;` block whose INTERNAL
 *     semicolons must not split it (tracked with an in-$$ toggle)
 * Anything fancier (nested dollar tags, quoted semicolons) is not present
 * in the file and deliberately unsupported — tests/test-migrate.mjs pins
 * the exact statement count so an unsupported construct sneaking into the
 * schema fails the battery instead of silently mis-splitting.
 */
export function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inDollar = false;
  for (const rawLine of sqlText.split('\n')) {
    // Strip full-line and trailing comments only when outside a $$ block
    // (the file's do-block contains no comments, but stay conservative).
    let line = rawLine;
    if (!inDollar) {
      const idx = line.indexOf('--');
      if (idx >= 0) line = line.slice(0, idx);
    }
    if (!line.trim() && !inDollar) { continue; }

    // Toggle the dollar-quote state once per $$ occurrence on the line.
    const dollarCount = (line.match(/\$\$/g) || []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;

    current += line + '\n';
    if (!inDollar && line.trimEnd().endsWith(';')) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
    }
  }
  const rest = current.trim();
  if (rest) statements.push(rest);
  return statements;
}

// The post-run sanity manifest: the tables (and the columns recent feature
// work depends on) that MUST exist for the deployed API to function. Kept
// hand-curated and small — its job is "did the migration actually land on
// THIS database", not schema completeness (the idempotent SQL is the
// authority on completeness).
export const REQUIRED_TABLES = [
  'users', 'clients', 'jobs', 'services', 'invoices', 'documents',
  'app_bookings', 'followups', 'portfolio', 'research', 'packages',
  'progress_logs', 'settings', 'line_channels', 'availability_slots',
  'bookings', 'team_members', 'order_requests',
];
export const REQUIRED_COLUMNS = [
  ['users', 'team_seats'],
  ['users', 'line_sub'],
  ['app_bookings', 'job_cuid'],
  ['app_bookings', 'customer_cuid'],
  ['jobs', 'client_cuid'],
  ['invoices', 'client_cuid'],
];

export async function schemaStatus(sql) {
  const tables = await sql(
    `select table_name from information_schema.tables where table_schema = 'public'`
  );
  const have = new Set(tables.map(r => r.table_name));
  const missingTables = REQUIRED_TABLES.filter(t => !have.has(t));

  const cols = await sql(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`
  );
  const haveCols = new Set(cols.map(r => `${r.table_name}.${r.column_name}`));
  const missingColumns = REQUIRED_COLUMNS
    .filter(([t, c]) => have.has(t) && !haveCols.has(`${t}.${c}`))
    .map(([t, c]) => `${t}.${c}`);

  const [db] = await sql(`select current_database() as name`);
  return {
    database: db ? db.name : null,   // name only — never the connection URL
    ok: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
  };
}

// Runs every schema statement in order. Statements are idempotent by the
// schema file's own convention (create/alter ... if not exists), so re-runs
// are safe; a genuinely failing statement is recorded and execution
// CONTINUES — later independent statements shouldn't be hostage to one
// failure, and the returned error list makes the failure investigable.
export async function runMigration(sql, statements) {
  const errors = [];
  let applied = 0;
  for (const stmt of statements) {
    try {
      await sql(stmt);
      applied++;
    } catch (err) {
      errors.push({ statement: stmt.slice(0, 120), error: err.message });
    }
  }
  return { applied, total: statements.length, errors };
}
