import { NextRequest, NextResponse } from "next/server";

/**
 * Vercel Cron invocations carry `Authorization: Bearer $CRON_SECRET` when
 * CRON_SECRET is set as a project env var. Returns a response to short-circuit
 * with, or null if the request is authorized.
 */
export function verifyCronRequest(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
