// Prisma 7 config for @grit/database (used by `npx prisma validate|generate`
// run from this package). The datasource url intentionally comes from the
// environment only — no dotenv, so CI/orchestrators control DATABASE_URL.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
