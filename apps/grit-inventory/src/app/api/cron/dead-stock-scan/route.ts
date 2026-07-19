import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyCronRequest } from "@/lib/cron";
import { scanDeadStock } from "@/lib/deadstock";

export async function GET(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const { flagged } = await scanDeadStock(db);
  return NextResponse.json({ ok: true, flagged });
}
