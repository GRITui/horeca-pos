import { requireTenantId } from "@/lib/tenant";
import { listReconciliationsForTenant, serializeReconciliation } from "@/app/api/reconciliation/_lib/queries";
import ReconciliationApp from "@/components/reconciliation/ReconciliationApp";

export default async function ReconciliationPage() {
  // layout.tsx already redirects unauthenticated staff to /login.
  const tenantId = await requireTenantId();

  const history = await listReconciliationsForTenant(tenantId);

  return <ReconciliationApp initialHistory={history.map(serializeReconciliation)} />;
}
