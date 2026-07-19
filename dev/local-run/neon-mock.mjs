// Local stand-in for @neondatabase/serverless's HTTP driver: neon(url)
// returns a tagged-template query function backed by node-postgres, which is
// enough for the taskboard app's `sql\`...\`` usage against local Postgres.
import pg from "pg";

const pools = new Map();

export function neon(url) {
  if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url, max: 5 }));
  const pool = pools.get(url);
  // Neon's driver supports both the tagged-template form (sql`...${v}`) and
  // the conventional form (sql("... $1", [v])); mirror both.
  return async function sql(first, ...rest) {
    if (Array.isArray(first) && Object.hasOwn(first, "raw")) {
      const text = first.reduce((acc, s, i) => acc + `$${i}` + s);
      const res = await pool.query(text, rest);
      return res.rows;
    }
    const res = await pool.query(first, rest[0] ?? []);
    return res.rows;
  };
}

export const neonConfig = {};
export default { neon, neonConfig };
