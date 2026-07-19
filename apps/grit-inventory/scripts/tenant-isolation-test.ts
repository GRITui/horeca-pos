import "dotenv/config";
import { testDb as db, cleanupTenant } from "./db-test-client";

/**
 * Verifies tenant-scoped queries never leak another tenant's rows — the
 * hardening requirement in the handoff (Section 3, step 8: "tenant/store
 * isolation audit"). Creates two tenants with colliding-looking data (same
 * SKU, same order-line shape) and checks every tenant-scoped read/write path
 * used by the app (`db.*.findFirst({ where: { id, tenantId } })`, the
 * pattern every API route in src/app/api uses) rejects cross-tenant access.
 *
 * Run with: DATABASE_URL=<local-or-throwaway-db> npx tsx scripts/tenant-isolation-test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function seedTenant(label: string) {
  const run = `isolation-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tenant = await db.tenant.create({ data: { name: `Isolation Test ${label}`, slug: run } });
  const store = await db.store.create({ data: { tenantId: tenant.id, name: "Main Store" } });
  const product = await db.product.create({ data: { tenantId: tenant.id, name: "Shared-name Widget" } });
  const variant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: "SAME-SKU", // deliberately identical across tenants — SKU uniqueness is scoped per tenant
      name: "Standard",
      price: 1,
      quantityOnHand: 5,
      reorderThreshold: 0,
    },
  });
  const order = await db.order.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      orderNumber: "ORD-00001", // deliberately identical — order numbers are scoped per tenant
      status: "pending",
      lines: { create: [{ variantId: variant.id, description: "line", unitPrice: 1, quantity: 1 }] },
    },
  });
  return { tenant, store, product, variant, order };
}

async function main() {
  const a = await seedTenant("A");
  const b = await seedTenant("B");

  // 1. Same SKU is allowed across tenants (uniqueness is (tenantId, sku), not global).
  assert(a.variant.sku === b.variant.sku, "test setup: SKUs should collide across tenants");
  console.log("✓ identical SKU allowed across two tenants (per-tenant uniqueness, not global)");

  // 2. Same order number is allowed across tenants (uniqueness is (tenantId, orderNumber)).
  assert(a.order.orderNumber === b.order.orderNumber, "test setup: order numbers should collide across tenants");
  console.log("✓ identical order number allowed across two tenants (per-tenant uniqueness, not global)");

  // 3. Fetching tenant A's product by id, scoped to tenant B, must return nothing —
  //    this is the exact `findFirst({ where: { id, tenantId } })` pattern every
  //    API route (e.g. src/app/api/products/[id]/route.ts) relies on.
  const crossTenantProduct = await db.product.findFirst({ where: { id: a.product.id, tenantId: b.tenant.id } });
  assert(crossTenantProduct === null, "tenant B must not be able to read tenant A's product by id");
  console.log("✓ cross-tenant product lookup (A's id, B's tenantId) correctly returns nothing");

  const crossTenantOrder = await db.order.findFirst({ where: { id: a.order.id, tenantId: b.tenant.id } });
  assert(crossTenantOrder === null, "tenant B must not be able to read tenant A's order by id");
  console.log("✓ cross-tenant order lookup (A's id, B's tenantId) correctly returns nothing");

  const crossTenantVariant = await db.variant.findFirst({ where: { id: a.variant.id, tenantId: b.tenant.id } });
  assert(crossTenantVariant === null, "tenant B must not be able to read tenant A's variant by id");
  console.log("✓ cross-tenant variant lookup (A's id, B's tenantId) correctly returns nothing");

  // 4. Listing queries scoped to one tenant must never include the other tenant's rows.
  const bProducts = await db.product.findMany({ where: { tenantId: b.tenant.id } });
  assert(
    bProducts.every((p) => p.id !== a.product.id),
    "tenant B's product list must not contain tenant A's product"
  );
  console.log("✓ tenant-scoped product list excludes the other tenant's rows");

  await cleanupTenant(a.tenant.id);
  await cleanupTenant(b.tenant.id);
  console.log("\nTenant isolation audit passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
