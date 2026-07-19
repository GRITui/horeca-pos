import { db } from "@/lib/db";
import { requireApiSession } from "@/lib/api";
import { csvResponse } from "@/lib/csv";

export async function GET() {
  const session = await requireApiSession();

  const snapshots = await db.forecastSnapshot.findMany({
    where: { tenantId: session.tenantId },
    orderBy: { createdAt: "desc" },
    include: { variant: { include: { product: true } } },
  });

  const latestByVariant = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    if (!latestByVariant.has(snapshot.variantId)) {
      latestByVariant.set(snapshot.variantId, snapshot);
    }
  }

  const rows = [...latestByVariant.values()]
    .filter((s) => s.suggestedReorderQty > 0)
    .map((s) => ({
      sku: s.variant.sku,
      product: s.variant.product.name,
      variant: s.variant.name,
      quantityOnHand: s.variant.quantityOnHand,
      forecastQty: s.forecastQty.toString(),
      suggestedReorderQty: s.suggestedReorderQty,
      computedAt: s.createdAt.toISOString(),
    }));

  return csvResponse(rows, "restock-suggestions.csv");
}
