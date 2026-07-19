import { redirect } from "next/navigation";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { getGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { TransfersManager } from "@/components/transfers-manager";

export const dynamic = "force-dynamic";

/** Transfer orders between stores (Grit pivot). Gated on
 * `inventory.transfers` (SCALE). */
export default async function TransfersPage() {
  const ctx = await getGritContext();
  if (!ctx) redirect("/login");

  if (
    !hasFeatureAccess(ctx.grit, "inventory.transfers") ||
    !hasFeatureAccess(ctx.grit, "inventory.multi_location")
  ) {
    return (
      <div>
        <PageHeader title="Transfers" description="Move stock between stores." />
        <Card>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Stock transfers are a SCALE feature
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Your current plan ({ctx.grit.tier}) tracks stock at a single location. Upgrade to
            SCALE to raise transfer orders between stores with full FIFO cost carry-over.
          </p>
        </Card>
      </div>
    );
  }

  const [transfers, stores, variants] = await Promise.all([
    db.stockTransfer.findMany({
      where: { tenantId: ctx.local.tenantId },
      include: {
        items: { include: { variant: { select: { sku: true, name: true } } } },
        fromStore: { select: { id: true, name: true } },
        toStore: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.store.findMany({
      where: { tenantId: ctx.local.tenantId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    db.variant.findMany({
      where: { tenantId: ctx.local.tenantId, isActive: true },
      include: { product: { select: { name: true } } },
      orderBy: { sku: "asc" },
    }),
  ]);

  return (
    <div>
      <PageHeader
        title="Transfers"
        description="Draft → dispatch (source decremented) → receive (destination incremented). Cancelling an in-transit transfer restores the source."
      />
      {/* TransfersManager (src/components/transfers-manager.tsx) renders its
          own table markup and is outside this pass's assigned scope; wrap the
          mount point so its table still gets horizontal scroll on narrow
          screens. */}
      <div className="overflow-x-auto">
      <TransfersManager
        transfers={transfers.map((t) => ({
          id: t.id,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
          fromStore: t.fromStore,
          toStore: t.toStore,
          items: t.items.map((i) => ({
            id: i.id,
            quantity: i.quantity,
            variant: { sku: i.variant.sku, name: i.variant.name },
          })),
        }))}
        stores={stores}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          productName: v.product.name,
        }))}
      />
      </div>
    </div>
  );
}
