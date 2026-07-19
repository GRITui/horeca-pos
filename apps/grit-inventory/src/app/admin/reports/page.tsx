import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { requireGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { daysAgo, formatCurrency, formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

function ExportLink({ href }: { href: string }) {
  return (
    <a href={href} className="text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300">
      Export CSV
    </a>
  );
}

export default async function ReportsPage() {
  const ctx = await requireGritContext();
  const { tenantId } = ctx.local;
  const fifoCosting = hasFeatureAccess(ctx.grit, "inventory.fifo_costing");
  const since = daysAgo(WINDOW_DAYS);

  const [recentOrders, variants, forecastSnapshots, deadStockFlags] = await Promise.all([
    db.order.findMany({
      where: { tenantId, createdAt: { gte: since }, status: { not: "cancelled" } },
      include: { lines: true },
    }),
    db.variant.findMany({ where: { tenantId, isActive: true } }),
    db.forecastSnapshot.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: { variant: { include: { product: true } } },
    }),
    db.deadStockFlag.findMany({
      where: { tenantId, resolvedAt: null },
      orderBy: { daysSinceLastSale: "desc" },
      take: 10,
      include: { variant: { include: { product: true } } },
    }),
  ]);

  const revenue = recentOrders.reduce(
    (sum, o) => sum + o.lines.reduce((lineSum, l) => lineSum + Number(l.unitPrice) * l.quantity, 0),
    0
  );
  const totalUnits = variants.reduce((sum, v) => sum + v.quantityOnHand, 0);
  const lowStockCount = variants.filter((v) => v.quantityOnHand <= v.reorderThreshold).length;

  const latestByVariant = new Map<string, (typeof forecastSnapshots)[number]>();
  for (const snapshot of forecastSnapshots) {
    if (!latestByVariant.has(snapshot.variantId)) latestByVariant.set(snapshot.variantId, snapshot);
  }
  const restockSuggestions = [...latestByVariant.values()]
    .filter((s) => s.suggestedReorderQty > 0)
    .sort((a, b) => b.suggestedReorderQty - a.suggestedReorderQty)
    .slice(0, 10);

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Sales, inventory, restock suggestions, and dead-stock."
        action={
          fifoCosting ? (
            <div className="flex flex-wrap items-center gap-3">
              <ExportLink href="/api/reports/cogs?format=csv" />
              <a
                href="/api/reports/cogs"
                className="text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
              >
                FIFO COGS (JSON)
              </a>
            </div>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Revenue (30d)</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{formatCurrency(revenue)}</p>
          <p className="text-xs text-zinc-500">{recentOrders.length} orders</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Units on hand</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{totalUnits}</p>
          <p className="text-xs text-zinc-500">across {variants.length} active variants</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Low stock</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{lowStockCount}</p>
          <p className="text-xs text-zinc-500">variants at or below reorder threshold</p>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Sales (30d)</h2>
            <ExportLink href="/api/reports/sales" />
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            {recentOrders.length} orders, {formatCurrency(revenue)} in revenue over the trailing {WINDOW_DAYS} days.
          </p>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Inventory levels</h2>
            <ExportLink href="/api/reports/inventory" />
          </div>
          <p className="mt-2 text-sm text-zinc-500">{variants.length} active variants, {lowStockCount} below threshold.</p>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Restock suggestions</h2>
            <ExportLink href="/api/reports/restock-suggestions" />
          </div>
          {restockSuggestions.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No suggestions from the latest forecast run.</p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {restockSuggestions.map((s) => (
                <li key={s.id} className="flex justify-between text-zinc-600 dark:text-zinc-400">
                  <span>
                    {s.variant.product.name} — {s.variant.name}
                  </span>
                  <span className="font-mono">+{s.suggestedReorderQty}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Dead stock</h2>
            <ExportLink href="/api/reports/dead-stock" />
          </div>
          {deadStockFlags.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No unresolved dead-stock flags.</p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {deadStockFlags.map((flag) => (
                <li key={flag.id} className="flex justify-between text-zinc-600 dark:text-zinc-400">
                  <span>
                    {flag.variant.product.name} — {flag.variant.name}
                  </span>
                  <span className="text-xs">{flag.daysSinceLastSale}d, flagged {formatDate(flag.flaggedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
