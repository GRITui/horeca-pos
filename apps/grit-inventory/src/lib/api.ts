import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import type { SessionPayload } from "@/lib/auth";

export function apiError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Middleware already guarantees a valid session for /api/**; this just surfaces it typed. */
export async function requireApiSession(): Promise<SessionPayload> {
  return requireSession();
}
