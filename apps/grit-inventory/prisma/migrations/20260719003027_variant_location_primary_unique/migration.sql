-- Enforce at most one primary VariantLocation row per (variantId, storeId).
--
-- Prisma's declarative schema DSL cannot express a partial unique index
-- (there is no precedent for one anywhere else in this app's migrations),
-- so this is hand-written raw SQL, per the pattern Prisma recommends for
-- customizing migrations with unsupported features:
-- https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations
--
-- Previously this exclusivity was app-level only (variant-locations POST /
-- PATCH routes flip any other primary row for the same storeId+variantId to
-- false before writing), so a bug or a direct DB write could still leave two
-- primary=true rows for the same SKU+store. This index makes that state
-- impossible at the database layer.
CREATE UNIQUE INDEX "VariantLocation_variantId_storeId_primary_key"
ON "VariantLocation" ("variantId", "storeId")
WHERE "isPrimary" = true;
