import { redirect } from "next/navigation";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { getGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { StoresManager } from "@/components/stores-manager";

export const dynamic = "force-dynamic";

/** Multi-location store management (Grit pivot). Gated on
 * `inventory.multi_location` — GROWTH tenants see an upsell panel instead of
 * the location tables. */
export default async function StoresPage() {
  const ctx = await getGritContext();
  if (!ctx) redirect("/login");

  if (!hasFeatureAccess(ctx.grit, "inventory.multi_location")) {
    return (
      <div>
        <PageHeader title="Stores" description="Manage your locations." />
        <Card>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Multi-location inventory is a SCALE feature
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Your current plan ({ctx.grit.tier}) tracks stock at a single location. Upgrade to
            SCALE to manage multiple stores, warehouses, and kitchens, and to move stock between
            them with transfer orders.
          </p>
        </Card>
      </div>
    );
  }

  const stores = await db.store.findMany({
    where: { tenantId: ctx.local.tenantId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, type: true, isDefault: true },
  });

  return (
    <div>
      <PageHeader
        title="Stores"
        description="Locations holding stock. The default store receives all operations that don't name a store; it cannot be deleted."
      />
      {/* StoresManager (src/components/stores-manager.tsx) renders its own table
          markup and is outside this pass's assigned scope; wrap the mount
          point so its table still gets horizontal scroll on narrow screens. */}
      <div className="overflow-x-auto">
        <StoresManager stores={stores} />
      </div>
    </div>
  );
}
