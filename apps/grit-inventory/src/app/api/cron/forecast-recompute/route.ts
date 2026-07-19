import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyCronRequest } from "@/lib/cron";
import { recomputeForecastSnapshots } from "@/lib/forecast";

export async function GET(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const { written } = await recomputeForecastSnapshots(db);
  return NextResponse.json({ ok: true, written });
}
