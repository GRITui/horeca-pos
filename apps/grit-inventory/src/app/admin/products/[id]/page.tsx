import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { AddVariantForm, VariantTable } from "@/components/variant-manager";
import { ArchiveProductButton, EditProductButton } from "@/components/product-form";
import { formatDate } from "@/lib/format";
import type { StockMovementReason } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const MOVEMENT_REASON_LABELS: Record<StockMovementReason, string> = {
  manual_adjustment: "Manual adjustment",
  order_fulfillment: "Order fulfillment",
  restock: "Restock",
  return: "Return",
  correction: "Correction",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  pos_sale: "POS sale",
};

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const product = await db.product.findFirst({
    where: { id, tenantId: session.tenantId },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });

  if (!product) notFound();

  const variants = product.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    name: v.name,
    price: v.price.toString(),
    quantityOnHand: v.quantityOnHand,
    reorderThreshold: v.reorderThreshold,
    isActive: v.isActive,
  }));

  const variantIds = product.variants.map((v) => v.id);
  const variantLabelById = new Map(product.variants.map((v) => [v.id, `${v.sku} — ${v.name}`]));

  const movements =
    variantIds.length > 0
      ? await db.stockMovement.findMany({
          where: { tenantId: session.tenantId, variantId: { in: variantIds } },
          include: { store: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : [];

  return (
    <div>
      <PageHeader
        title={product.isActive ? product.name : `${product.name} (inactive)`}
        description={product.description ?? undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <EditProductButton product={{ id: product.id, name: product.name, description: product.description }} />
            <ArchiveProductButton product={{ id: product.id, isActive: product.isActive }} />
          </div>
        }
      />

      <Card className="p-0">
        <div className="p-4">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Variants</h2>
        </div>
        {variants.length > 0 && (
          <div className="overflow-x-auto">
            <VariantTable variants={variants} />
          </div>
        )}
        <div className="px-4 pb-4">
          <AddVariantForm productId={product.id} />
        </div>
      </Card>

      <Card className="mt-6 p-0">
        <div className="p-4">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Movement history</h2>
        </div>
        {movements.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState message="No stock movements yet." />
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">Variant</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">Store</th>
                <th className="px-4 py-3 font-medium">Delta</th>
                <th className="px-4 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => {
                const positive = movement.delta > 0;
                return (
                  <tr
                    key={movement.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                  >
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-50">
                      {variantLabelById.get(movement.variantId) ?? movement.variantId}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {MOVEMENT_REASON_LABELS[movement.reason]}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {movement.store?.name ?? "—"}
                    </td>
                    <td
                      className={`px-4 py-3 font-mono ${
                        positive ? "text-emerald-600" : "text-red-600"
                      }`}
                    >
                      {positive ? "+" : ""}
                      {movement.delta}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {formatDate(movement.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </div>
  );
}
