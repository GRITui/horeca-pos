import Link from "next/link";
import { redirect } from "next/navigation";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { getGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { LocationsManager } from "@/components/locations-manager";

export const dynamic = "force-dynamic";

/**
 * Item location / planogram management (Grit WMS epic). Gated on
 * `inventory.multi_location` (SCALE) — same location-table visibility gate
 * as Stores/Transfers/the Products store filter.
 */
export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const ctx = await getGritContext();
  if (!ctx) redirect("/login");

  if (!hasFeatureAccess(ctx.grit, "inventory.multi_location")) {
    return (
      <div>
        <PageHeader title="Locations" description="Planogram slots per store — where each SKU lives on the floor." />
        <Card>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Item locations are a SCALE feature
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Your current plan ({ctx.grit.tier}) tracks a single location. Upgrade to SCALE to manage
            per-store planogram slots.
          </p>
        </Card>
      </div>
    );
  }

  const { store: storeParam } = await searchParams;

  const stores = await db.store.findMany({
    where: { tenantId: ctx.local.tenantId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });

  if (stores.length === 0) {
    return (
      <div>
        <PageHeader title="Locations" description="Planogram slots per store — where each SKU lives on the floor." />
        <Card>
          <p className="text-sm text-zinc-500">Create a store first.</p>
        </Card>
      </div>
    );
  }

  const selectedStore = stores.find((s) => s.id === storeParam) ?? stores[0];

  const [locations, variants] = await Promise.all([
    db.variantLocation.findMany({
      where: { tenantId: ctx.local.tenantId, storeId: selectedStore.id },
      include: {
        variant: { select: { id: true, sku: true, name: true, product: { select: { name: true } } } },
      },
      orderBy: [{ isPrimary: "desc" }, { code: "asc" }],
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
        title="Locations"
        description="Planogram slots per store — where each SKU lives on the floor. Scan a barcode to jump to it."
      />

      {stores.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Store:</span>
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/admin/locations?store=${s.id}`}
              className={`rounded-md px-2.5 py-1 font-medium ${
                selectedStore.id === s.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <LocationsManager
        storeId={selectedStore.id}
        storeName={selectedStore.name}
        locations={locations.map((l) => ({
          id: l.id,
          code: l.code,
          zone: l.zone,
          notes: l.notes,
          isPrimary: l.isPrimary,
          variant: {
            id: l.variant.id,
            sku: l.variant.sku,
            name: l.variant.name,
            productName: l.variant.product.name,
          },
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          productName: v.product.name,
        }))}
      />
    </div>
  );
}
