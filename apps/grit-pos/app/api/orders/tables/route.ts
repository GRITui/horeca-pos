import { NextResponse } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "../_lib/http";

/** GET /api/orders/tables — tenant's dine-in tables, for the "new order" table picker. */
export async function GET() {
  try {
    const tenantId = await requireTenantId();
    const tables = await prisma.table.findMany({
      where: { tenantId },
      select: { id: true, label: true },
      orderBy: { label: "asc" },
    });
    return NextResponse.json({ tables });
  } catch (err) {
    return errorResponse(err);
  }
}
