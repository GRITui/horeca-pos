// Sidekick — lib/schemaSql.js must stay a VERBATIM copy of
// sql/schema-core.sql (api/admin-migrate.js applies the embedded copy).
// When this fails, regenerate the module from the repo root with:
//
//   node -e "const fs=require('fs');const sql=fs.readFileSync('sql/schema-core.sql','utf8');const escaped=sql.replace(/\\\\/g,'\\\\\\\\').replace(/\`/g,'\\\\\`').replace(/\\$\\{/g,'\\\\\${');const head=fs.readFileSync('lib/schemaSql.js','utf8').split('export const')[0];fs.writeFileSync('lib/schemaSql.js',head+'export const SCHEMA_SQL = \`'+escaped+'\`;\n')"
//
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SCHEMA_SQL } from '../lib/schemaSql.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fileSql = readFileSync(join(root, 'sql/schema-core.sql'), 'utf8');

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

assert(SCHEMA_SQL === fileSql,
  'lib/schemaSql.js has drifted from sql/schema-core.sql — regenerate it (command in this file\'s header)');
assert(SCHEMA_SQL.includes('create table if not exists team_members'),
  'embedded schema carries the team_members table');
assert(SCHEMA_SQL.includes('add column if not exists client_cuid'),
  'embedded schema carries the Pass-A.2 ref-cuid alters');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
