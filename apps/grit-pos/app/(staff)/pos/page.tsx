import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { listOrdersForTenant, serializeOrder } from "@/app/api/orders/_lib/queries";
import { getCatalogForTenant, serializeCatalog } from "@/app/api/catalog/_lib/catalog";
import { getEnabledTraits } from "@/lib/traits";
import { getGritSession, sessionHasFeature } from "@/lib/passportBridge";
import OrderDashboard from "@/components/pos/OrderDashboard";

export default async function PosDashboardPage() {
  // layout.tsx already redirects unauthenticated staff to /login.
  const tenantId = await requireTenantId();

  const [traits, gritSession] = await Promise.all([
    getEnabledTraits(tenantId),
    getGritSession(),
  ]);
  const tablesEnabled = traits.has("hospitality.tables");
  const offlineEnabled = sessionHasFeature(gritSession, "pos.offline_mode");

  const [orders, tables, categories] = await Promise.all([
    listOrdersForTenant(tenantId, [OrderStatus.open, OrderStatus.tendered]),
    // The table picker is a "hospitality.tables" plugin-trait surface.
    tablesEnabled
      ? prisma.table.findMany({
          where: { tenantId },
          select: { id: true, label: true },
          orderBy: { label: "asc" },
        })
      : Promise.resolve([]),
    // Catalog feeds the offline quick-sale panel.
    offlineEnabled ? getCatalogForTenant(tenantId) : Promise.resolve([]),
  ]);

  return (
    <OrderDashboard
      initialOrders={await Promise.all(orders.map(serializeOrder))}
      tables={tables}
      tablesEnabled={tablesEnabled}
      offlineEnabled={offlineEnabled}
      catalog={serializeCatalog(categories)}
    />
  );
}
