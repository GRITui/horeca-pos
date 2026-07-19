import { db } from "@/lib/db";
import { requireApiSession } from "@/lib/api";
import { csvResponse } from "@/lib/csv";

export async function GET() {
  const session = await requireApiSession();

  const flags = await db.deadStockFlag.findMany({
    where: { tenantId: session.tenantId, resolvedAt: null },
    orderBy: { daysSinceLastSale: "desc" },
    include: { variant: { include: { product: true } } },
  });

  const rows = flags.map((flag) => ({
    sku: flag.variant.sku,
    product: flag.variant.product.name,
    variant: flag.variant.name,
    quantityOnHand: flag.quantityOnHand,
    daysSinceLastSale: flag.daysSinceLastSale,
    reason: flag.reason,
    flaggedAt: flag.flaggedAt.toISOString(),
  }));

  return csvResponse(rows, "dead-stock-report.csv");
}
