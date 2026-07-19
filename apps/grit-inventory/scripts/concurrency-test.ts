import "dotenv/config";
import { testDb as db, cleanupTenant } from "./db-test-client";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import { transitionOrder } from "@/lib/orders";

/**
 * Verifies the row-locking (`SELECT ... FOR UPDATE`) in lib/inventory.ts
 * actually serializes concurrent decrements instead of racing — the
 * hardening requirement called out in the handoff (Section 3, step 8):
 * "Concurrency tests for stock decrement under simultaneous order entry."
 *
 * Two scenarios:
 * 1. `testStockPrimitiveConcurrency` — starts a variant at 5 units on hand,
 *    fires 10 concurrent decrement-by-1 transactions directly at
 *    `applyStockMovement`, and asserts exactly 5 succeed.
 * 2. `testOrderEntryConcurrency` — the actual "simultaneous order entry"
 *    scenario: creates 10 real Orders/OrderLines (1 unit each) against a
 *    shared contested variant with 5 units on hand, then drives all 10
 *    concurrently through `transitionOrder` (paid -> fulfilling) — the same
 *    `db.$transaction((tx) => transitionOrder(...))` path the
 *    `/api/orders/[id]/transition` route uses — asserting exactly 5 orders
 *    fulfill, 5 are rejected with InsufficientStockError and stay `paid`,
 *    and stock/audit rows never oversell.
 *
 * Run with: DATABASE_URL=<local-or-throwaway-db> npx tsx scripts/concurrency-test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const STARTING_STOCK = 5;
const CONCURRENT_ORDERS = 10;

async function testStockPrimitiveConcurrency() {
  const run = `concurrency-${Date.now()}`;

  const tenant = await db.tenant.create({ data: { name: `Concurrency Test ${run}`, slug: run } });
  const store = await db.store.create({ data: { tenantId: tenant.id, name: "Main Store" } });
  const product = await db.product.create({ data: { tenantId: tenant.id, name: "Contested Widget" } });
  const variant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `CONTESTED-${run}`,
      name: "Standard",
      price: 4.5,
      quantityOnHand: STARTING_STOCK,
      reorderThreshold: 0,
    },
  });
  console.log(`✓ variant starts at ${STARTING_STOCK} units on hand`);
  console.log(`Firing ${CONCURRENT_ORDERS} concurrent decrement-by-1 transactions...`);

  const attempts = Array.from({ length: CONCURRENT_ORDERS }, (_, i) =>
    db
      .$transaction((tx) =>
        applyStockMovement(tx, {
          tenantId: tenant.id,
          storeId: store.id,
          variantId: variant.id,
          delta: -1,
          reason: "order_fulfillment",
          note: `concurrency test attempt ${i}`,
        })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }))
  );

  const results = await Promise.all(attempts);
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const insufficientStockFailures = failed.filter(
    (r) => !r.ok && r.err instanceof InsufficientStockError
  );

  assert(succeeded.length === STARTING_STOCK, `expected exactly ${STARTING_STOCK} successes, got ${succeeded.length}`);
  assert(failed.length === CONCURRENT_ORDERS - STARTING_STOCK, `expected ${CONCURRENT_ORDERS - STARTING_STOCK} failures, got ${failed.length}`);
  assert(
    insufficientStockFailures.length === failed.length,
    "every failure should be InsufficientStockError, not some other error (e.g. a race condition corrupting state)"
  );
  console.log(`✓ exactly ${succeeded.length} succeeded, ${failed.length} correctly rejected as insufficient stock`);

  const final = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert(final.quantityOnHand === 0, `expected final stock 0, got ${final.quantityOnHand}`);
  assert(final.quantityOnHand >= 0, "stock must never go negative");
  console.log("✓ final stock is exactly 0 — no oversell, no negative stock, no lost updates");

  const movementCount = await db.stockMovement.count({ where: { variantId: variant.id } });
  assert(movementCount === STARTING_STOCK, `expected ${STARTING_STOCK} audit rows, got ${movementCount}`);
  console.log(`✓ exactly ${STARTING_STOCK} StockMovement audit rows written (one per successful decrement)`);

  await cleanupTenant(tenant.id);
  console.log("\nStock primitive concurrency test passed.");
}

/**
 * The scenario the handoff doc actually specifies: simultaneous order entry.
 * Two (or more) staff members concurrently fulfilling different orders that
 * reference the same variant, driven through the real order-transition code
 * path rather than the bare `applyStockMovement` primitive.
 */
async function testOrderEntryConcurrency() {
  const run = `order-concurrency-${Date.now()}`;

  const tenant = await db.tenant.create({ data: { name: `Order Concurrency Test ${run}`, slug: run } });
  const store = await db.store.create({ data: { tenantId: tenant.id, name: "Main Store" } });
  const user = await db.user.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      email: `${run}@example.com`,
      passwordHash: "not-used-by-this-script",
      name: "Concurrency Tester",
      role: "OWNER",
    },
  });
  const product = await db.product.create({ data: { tenantId: tenant.id, name: "Contested Widget" } });
  const variant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `ORDER-CONTESTED-${run}`,
      name: "Standard",
      price: 4.5,
      quantityOnHand: STARTING_STOCK,
      reorderThreshold: 0,
    },
  });
  console.log(`\n✓ [order entry] variant starts at ${STARTING_STOCK} units on hand`);

  const orders = [];
  for (let i = 0; i < CONCURRENT_ORDERS; i++) {
    const order = await db.order.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        orderNumber: `ORD-CONC-${run}-${i}`,
        status: "paid",
        createdById: user.id,
        customerName: `Customer ${i}`,
        customerAddress: "1 Race Condition Ave",
        lines: {
          create: [{ variantId: variant.id, description: variant.name, unitPrice: variant.price, quantity: 1 }],
        },
      },
    });
    orders.push(order);
  }
  console.log(`Firing ${CONCURRENT_ORDERS} concurrent order fulfillments (paid -> fulfilling) against it...`);

  const attempts = orders.map((order) =>
    db
      .$transaction((tx) =>
        transitionOrder(tx, {
          tenantId: tenant.id,
          storeId: store.id,
          orderId: order.id,
          to: "fulfilling",
          actingUserId: user.id,
        })
      )
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }))
  );

  const results = await Promise.all(attempts);
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const insufficientStockFailures = failed.filter(
    (r) => !r.ok && r.err instanceof InsufficientStockError
  );

  assert(succeeded.length === STARTING_STOCK, `expected exactly ${STARTING_STOCK} orders to fulfill, got ${succeeded.length}`);
  assert(failed.length === CONCURRENT_ORDERS - STARTING_STOCK, `expected ${CONCURRENT_ORDERS - STARTING_STOCK} orders to be rejected, got ${failed.length}`);
  assert(
    insufficientStockFailures.length === failed.length,
    "every rejected order should fail with InsufficientStockError, not some other error (e.g. a race condition corrupting state)"
  );
  console.log(`✓ exactly ${succeeded.length} orders fulfilled, ${failed.length} correctly rejected as insufficient stock`);

  const finalVariant = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert(finalVariant.quantityOnHand === 0, `expected final stock 0, got ${finalVariant.quantityOnHand}`);
  assert(finalVariant.quantityOnHand >= 0, "stock must never go negative");
  console.log("✓ final stock is exactly 0 — no oversell, no negative stock, no lost updates across concurrent order entry");

  const movementCount = await db.stockMovement.count({ where: { variantId: variant.id } });
  assert(movementCount === STARTING_STOCK, `expected ${STARTING_STOCK} audit rows, got ${movementCount}`);
  console.log(`✓ exactly ${STARTING_STOCK} StockMovement audit rows written (one per fulfilled order)`);

  const finalOrders = await db.order.findMany({ where: { tenantId: tenant.id } });
  const fulfillingCount = finalOrders.filter((o) => o.status === "fulfilling").length;
  const paidCount = finalOrders.filter((o) => o.status === "paid").length;
  assert(fulfillingCount === STARTING_STOCK, `expected ${STARTING_STOCK} orders left in 'fulfilling', got ${fulfillingCount}`);
  assert(paidCount === CONCURRENT_ORDERS - STARTING_STOCK, `expected rejected orders to remain 'paid', got ${paidCount}`);
  console.log("✓ fulfilled orders moved to 'fulfilling'; rejected orders correctly rolled back to 'paid'");

  await cleanupTenant(tenant.id);
  console.log("\nOrder-entry concurrency test passed.");
}

async function main() {
  await testStockPrimitiveConcurrency();
  await testOrderEntryConcurrency();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
