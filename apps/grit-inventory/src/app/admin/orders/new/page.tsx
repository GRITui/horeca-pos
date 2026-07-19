import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { NewOrderForm } from "@/components/order-form";

export const dynamic = "force-dynamic";

export default async function NewOrderPage() {
  const session = await requireSession();
  const variants = await db.variant.findMany({
    where: { tenantId: session.tenantId, isActive: true },
    include: { product: true },
    orderBy: { name: "asc" },
  });

  const options = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    name: v.name,
    productName: v.product.name,
    price: v.price.toString(),
    quantityOnHand: v.quantityOnHand,
  }));

  return (
    <div>
      <PageHeader title="New order" />
      <NewOrderForm variants={options} />
    </div>
  );
}
