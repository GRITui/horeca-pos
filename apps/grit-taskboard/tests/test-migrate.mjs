// Sidekick — api/admin-migrate.js + lib/migrate.js: statement splitting
// ($$-block safety), token gating, status manifest, and the run loop.
process.env.SETUP_TOKEN = 'test-setup-token';

import { SCHEMA_SQL } from '../lib/schemaSql.js';
import { splitSqlStatements, schemaStatus, runMigration, REQUIRED_TABLES } from '../lib/migrate.js';
import handler from '../api/admin-migrate.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── Splitter ─────────────────────────────────────────────────────────────
const stmts = splitSqlStatements(SCHEMA_SQL);
assert(stmts.length > 40, `splitter yields a full statement set (got ${stmts.length})`);
assert(stmts.every(s => !s.startsWith('--')), 'no comment-only statements survive');
const dollarStmts = stmts.filter(s => s.includes('$$'));
assert(dollarStmts.length === 1, `exactly one dollar-quoted do-block (got ${dollarStmts.length})`);
assert(dollarStmts[0].trimStart().startsWith('do $$') && dollarStmts[0].includes('end $$;'),
  'the do-block survives as ONE statement despite internal semicolons');
assert(stmts.some(s => s.startsWith('create table if not exists team_members')), 'team_members create present');
assert(stmts.some(s => s.includes('add column if not exists customer_cuid')), 'ref-cuid alter present');
// Every non-final statement ends with ; and none is empty
assert(stmts.every(s => s.length > 5), 'no fragment statements');

// ── runMigration: order + error isolation ────────────────────────────────
{
  const seen = [];
  const failingSql = async (stmt) => {
    seen.push(stmt);
    if (seen.length === 2) throw new Error('boom');
    return [];
  };
  const r = await runMigration(failingSql, ['s1;', 's2;', 's3;']);
  assert(r.applied === 2 && r.total === 3 && r.errors.length === 1,
    'a failing statement is recorded and execution continues');
  assert(seen.length === 3, 'all statements attempted in order');
}

// ── schemaStatus manifest ────────────────────────────────────────────────
{
  const fakeSql = async (text) => {
    if (text.includes('information_schema.tables')) {
      return REQUIRED_TABLES.filter(t => t !== 'team_members').map(t => ({ table_name: t }));
    }
    if (text.includes('information_schema.columns')) {
      return [{ table_name: 'users', column_name: 'team_seats' }, { table_name: 'users', column_name: 'line_sub' }];
    }
    if (text.includes('current_database')) return [{ name: 'testdb' }];
    throw new Error('unexpected: ' + text);
  };
  const s = await schemaStatus(fakeSql);
  assert(s.ok === false && s.missingTables.includes('team_members'), 'missing table detected');
  assert(s.database === 'testdb', 'reports database NAME only');
  assert(!JSON.stringify(s).includes('postgres://'), 'never leaks a connection string shape');
  // columns on missing tables are not double-reported
  assert(!s.missingColumns.some(c => c.startsWith('team_members.')), 'columns of missing tables not double-counted');
}

// ── Endpoint token gating ────────────────────────────────────────────────
const call = (method, tokenHeader) => handler(new Request('https://x/api/admin-migrate', {
  method, headers: tokenHeader ? { 'x-setup-token': tokenHeader } : {},
}));
{
  let res = await call('GET', 'wrong-token');
  assert(res.status === 403, 'wrong token → 403');
  res = await call('GET', null);
  assert(res.status === 403, 'missing token → 403');
  const saved = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  res = await call('GET', 'anything');
  assert(res.status === 404, 'unset SETUP_TOKEN disables the endpoint entirely (404)');
  process.env.SETUP_TOKEN = saved;
  // Correct token reaches the DB layer (no DATABASE_URL in this harness →
  // db() throws → wrapped as 502, proving the gate passed).
  res = await call('GET', 'test-setup-token');
  assert(res.status === 502, 'correct token passes the gate (fails later only at the missing test DB)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
