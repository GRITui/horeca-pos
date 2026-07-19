/**
 * @grit/database — centralized shared schema, migrations, and DB helpers for
 * Grit BizSuite. See README.md for the full picture.
 */

export { createNeonOutboxStore } from "./outbox.js";

/**
 * Ordered list of SQL migration files, relative to this package's root.
 * Apply them in order against the shared Neon database (psql, Neon SQL
 * editor, or your own runner). Every file is idempotent (IF NOT EXISTS /
 * ADD COLUMN IF NOT EXISTS guards), so re-applying is safe.
 *
 * Resolve to absolute paths from a consuming app with e.g.:
 *   const root = path.dirname(require.resolve("@grit/database/package.json"));
 *   const files = MIGRATION_FILES.map((f) => path.join(root, f));
 */
export const MIGRATION_FILES = [
  "migrations/0001_core.sql",
  "migrations/0002_platform_extensions.sql",
] as const;

/**
 * Demo/dev seed data (SCALE-tier org with addons, locations, catalog,
 * stock, and one user per role), relative to this package's root.
 * Idempotent via fixed UUIDs + ON CONFLICT DO NOTHING. Never run in
 * production.
 */
export const SEED_FILES = ["seed/seed.sql"] as const;
