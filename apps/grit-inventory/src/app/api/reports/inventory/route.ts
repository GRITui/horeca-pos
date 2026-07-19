import { db } from "@/lib/db";
import { requireApiSession } from "@/lib/api";
import { csvResponse } from "@/lib/csv";

export async function GET() {
  const session = await requireApiSession();
  const variants = await db.variant.findMany({
    where: { tenantId: session.tenantId, isActive: true },
    include: { product: true },
    orderBy: { sku: "asc" },
  });

  const rows = variants.map((v) => ({
    sku: v.sku,
    product: v.product.name,
    variant: v.name,
    price: v.price.toString(),
    quantityOnHand: v.quantityOnHand,
    reorderThreshold: v.reorderThreshold,
    lowStock: v.quantityOnHand <= v.reorderThreshold,
  }));

  return csvResponse(rows, "inventory-report.csv");
}
