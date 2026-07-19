import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyCronRequest } from "@/lib/cron";
import { checkRestockAlerts } from "@/lib/restock";

export async function GET(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const { alertCount } = await checkRestockAlerts(db);
  return NextResponse.json({ ok: true, alertCount });
}
