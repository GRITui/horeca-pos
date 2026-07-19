import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireApiSession } from "@/lib/api";
import { csvResponse } from "@/lib/csv";

const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const session = await requireApiSession();
  const fromParam = request.nextUrl.searchParams.get("from");
  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS);

  const orders = await db.order.findMany({
    where: { tenantId: session.tenantId, createdAt: { gte: from }, status: { not: "cancelled" } },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });

  const rows = orders.map((order) => ({
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName ?? "",
    total: order.lines.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0).toFixed(2),
    itemCount: order.lines.reduce((sum, l) => sum + l.quantity, 0),
    createdAt: order.createdAt.toISOString(),
  }));

  return csvResponse(rows, "sales-report.csv");
}
