import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
import { PrismaClient } from "@/app/generated/prisma/client";

// Prisma 7 no longer reads `datasource.url` from schema.prisma — the client
// must be constructed with an explicit driver adapter. We use the Neon
// serverless driver adapter since this app targets Neon Postgres, which
// works both in normal Node.js runtimes and on serverless/edge deploys
// (e.g. Vercel) without needing a persistent TCP connection.
// https://www.prisma.io/docs/orm/overview/databases/neon
neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;

// Local dev fallback: the Neon serverless driver only speaks to Neon's
// websocket proxy, so a localhost/127.0.0.1 DATABASE_URL (plain Postgres)
// uses the node-postgres adapter instead. Deploys targeting Neon are
// unaffected; @prisma/adapter-pg resolves from the workspace root in dev.
function isLocalPostgres(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function createPrismaClient() {
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill in a real Neon connection string.",
    );
  }

  if (isLocalPostgres(connectionString)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg") as {
      PrismaPg: typeof PrismaNeon;
    };
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }

  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({ adapter });
}

// Standard Next.js Prisma client singleton, using a globalThis cache so
// hot-reloading in dev (and serverless/edge cold starts) don't spin up a
// new PrismaClient — and a new connection pool — on every module reload.
// https://www.prisma.io/docs/orm/more/help-and-troubleshooting/help-articles/nextjs-prisma-client-dev-practices
//
// Grit pivot: construction is LAZY (first property access) rather than at
// module load, so `next build` succeeds with no DATABASE_URL set — importing
// a route module during page-data collection must not throw. The missing-env
// error now surfaces on the first actual query instead.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let cached: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (cached) return cached;
  cached = globalForPrisma.prisma ?? createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = cached;
  }
  return cached;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
});

export default prisma;
