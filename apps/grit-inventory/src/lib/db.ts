import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { PrismaClient } from "@/generated/prisma/client";

// Node runtime (Vercel Cron routes, local dev) needs an explicit WebSocket
// implementation; the Vercel Edge/serverless runtime provides one natively.
neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Local dev fallback: the Neon serverless driver only speaks to Neon's
// websocket proxy, so a localhost DATABASE_URL (plain Postgres) uses the
// node-postgres adapter instead (same adapter the test scripts use).
function isLocalPostgres(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (isLocalPostgres(connectionString)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg") as {
      PrismaPg: typeof PrismaNeon;
    };
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  }
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
