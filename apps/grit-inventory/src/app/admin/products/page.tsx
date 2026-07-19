import Link from "next/link";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { requireGritContext } from "@/lib/passport";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { formatCurrency } from "@/lib/format";
import { ProductsBarcodeListener } from "@/components/barcode-listener";

export const dynamic = "force-dynamic";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ inactive?: string; store?: string }>;
}) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  const { inactive, store: storeParam } = await searchParams;
  const showInactive = inactive === "1";

  // Store filter (Grit pivot): SCALE tenants can view per-store quantities.
  // GROWTH tenants never see the filter — they are gated from reading
  // multiple location tables (`inventory.multi_location`).
  const multiLocation = hasFeatureAccess(ctx.grit, "inventory.multi_location");
  const stores = multiLocation
    ? await db.store.findMany({
        where: { tenantId: session.tenantId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { id: true, name: true },
      })
    : [];
  const selectedStore = multiLocation
    ? stores.find((s) => s.id === storeParam) ?? null
    : null;

  const products = await db.product.findMany({
    where: { tenantId: session.tenantId, isActive: !showInactive },
    include: { variants: { where: { isActive: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Per-store quantities when a store filter is active.
  const storeQuantities = new Map<string, number>();
  if (selectedStore) {
    const rows = await db.storeStock.findMany({
      where: { tenantId: session.tenantId, storeId: selectedStore.id },
      select: { variantId: true, quantityOnHand: true },
    });
    for (const row of rows) storeQuantities.set(row.variantId, row.quantityOnHand);
  }
  const quantityOf = (variantId: string, aggregate: number) =>
    selectedStore ? storeQuantities.get(variantId) ?? 0 : aggregate;

  const inactiveHref = showInactive ? "/admin/products" : "/admin/products?inactive=1";
  const storeQuery = selectedStore ? `&store=${selectedStore.id}` : "";

  return (
    <div>
      <ProductsBarcodeListener />
      <PageHeader
        title="Products"
        description={
          selectedStore
            ? `Stock levels at ${selectedStore.name}. Scan a barcode to jump to its product.`
            : "Manage catalog and stock levels. Scan a barcode to jump to its product."
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`${inactiveHref}${storeQuery}`}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {showInactive ? "Show active products" : "Show inactive products"}
            </Link>
            <LinkButton href="/admin/products/new">New product</LinkButton>
          </div>
        }
      />

      {multiLocation && stores.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Store:</span>
          <Link
            href={showInactive ? "/admin/products?inactive=1" : "/admin/products"}
            className={`rounded-md px-2.5 py-1 font-medium ${
              !selectedStore
                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            All stores
          </Link>
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/admin/products?${showInactive ? "inactive=1&" : ""}store=${s.id}`}
              className={`rounded-md px-2.5 py-1 font-medium ${
                selectedStore?.id === s.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState
          message={
            showInactive ? "No inactive products." : "No products yet. Create your first product to get started."
          }
        />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Variants</th>
                <th className="px-4 py-3 font-medium">
                  {selectedStore ? `Stock @ ${selectedStore.name}` : "Total stock"}
                </th>
                <th className="px-4 py-3 font-medium">Price range</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const totalStock = product.variants.reduce(
                  (sum, v) => sum + quantityOf(v.id, v.quantityOnHand),
                  0
                );
                const prices = product.variants.map((v) => Number(v.price));
                const lowStock = product.variants.some(
                  (v) => quantityOf(v.id, v.quantityOnHand) <= v.reorderThreshold
                );
                return (
                  <tr
                    key={product.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/products/${product.id}`}
                        className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                      >
                        {product.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{product.variants.length}</td>
                    <td className={`px-4 py-3 font-mono ${lowStock ? "text-red-600" : "text-zinc-600 dark:text-zinc-400"}`}>
                      {totalStock}
                      {lowStock && <span className="ml-2 text-xs">low</span>}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {prices.length > 0
                        ? `${formatCurrency(Math.min(...prices))} – ${formatCurrency(Math.max(...prices))}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  );
}
