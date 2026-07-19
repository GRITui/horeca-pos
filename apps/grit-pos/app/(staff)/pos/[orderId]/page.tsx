import { notFound } from "next/navigation";
import { requireTenantId } from "@/lib/tenant";
import { findOrderForTenant, serializeOrder } from "@/app/api/orders/_lib/queries";
import { getCatalogForTenant, serializeCatalog } from "@/app/api/catalog/_lib/catalog";
import { getEnabledTraits } from "@/lib/traits";
import { getGritSession, sessionHasFeature } from "@/lib/passportBridge";
import OrderBuilder from "@/components/pos/OrderBuilder";

export default async function PosOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  // layout.tsx already redirects unauthenticated staff to /login.
  const tenantId = await requireTenantId();
  const { orderId } = await params;

  const [order, categories, traits, gritSession] = await Promise.all([
    findOrderForTenant(tenantId, orderId),
    getCatalogForTenant(tenantId),
    getEnabledTraits(tenantId),
    getGritSession(),
  ]);

  if (!order) {
    notFound();
  }

  return (
    <OrderBuilder
      initialOrder={await serializeOrder(order)}
      catalog={serializeCatalog(categories)}
      matrixEnabled={traits.has("retail.variant_matrix")}
      offlineEnabled={sessionHasFeature(gritSession, "pos.offline_mode")}
    />
  );
}
