import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron";
import { getEventBus } from "@/lib/events";

/**
 * Cron: re-attempt delivery of undelivered outbox events (see
 * @grit/shared-events `drainOutbox`). Guarded by CRON_SECRET like every
 * other cron route; inert when DATABASE_URL is unset.
 */
export async function GET(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ skipped: true, reason: "DATABASE_URL not configured" });
  }

  const results = await getEventBus().drainOutbox();
  const redelivered = results.filter((r) => r.failures.length === 0).length;
  return NextResponse.json({
    ok: true,
    attempted: results.length,
    redelivered,
    stillFailing: results.length - redelivered,
  });
}
