import "dotenv/config";
import { testDb as db, cleanupTenant } from "./db-test-client";
import { transitionOrder, generateOrderNumber } from "@/lib/orders";
import { canTransitionDelivery } from "@/lib/deliveries";

/**
 * Ad-hoc end-to-end smoke test for the M1 order-fulfillment core loop:
 * product/variant creation -> order entry -> payment -> fulfillment
 * (atomic stock decrement) -> delivery creation -> delivery status updates.
 *
 * Run with: DATABASE_URL=<local-or-throwaway-db> npx tsx scripts/smoke-test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const run = `smoke-${Date.now()}`;

  const tenant = await db.tenant.create({ data: { name: `Smoke Test ${run}`, slug: run } });
  const store = await db.store.create({ data: { tenantId: tenant.id, name: "Main Store" } });
  const user = await db.user.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      email: `${run}@example.com`,
      passwordHash: "not-used-by-this-script",
      name: "Smoke Tester",
      role: "OWNER",
    },
  });

  const product = await db.product.create({ data: { tenantId: tenant.id, name: "Widget" } });
  const variant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `WIDGET-${run}`,
      name: "Standard",
      price: 9.99,
      quantityOnHand: 10,
      reorderThreshold: 2,
    },
  });
  console.log("✓ created tenant/store/user/product/variant, stock=10");

  const orderNumber = await db.$transaction((tx) => generateOrderNumber(tx, tenant.id));
  const order = await db.order.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      orderNumber,
      status: "pending",
      createdById: user.id,
      customerName: "Ada Lovelace",
      customerAddress: "1 Analytical Engine Way",
      lines: {
        create: [{ variantId: variant.id, description: variant.name, unitPrice: variant.price, quantity: 3 }],
      },
    },
    include: { lines: true },
  });
  assert(order.status === "pending", "new order should be pending");
  console.log(`✓ created order ${order.orderNumber} (qty 3)`);

  await db.payment.create({
    data: { orderId: order.id, method: "cash", status: "completed", amount: 29.97 },
  });
  await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
  console.log("✓ recorded payment, order -> paid");

  await db.$transaction((tx) =>
    transitionOrder(tx, { tenantId: tenant.id, storeId: store.id, orderId: order.id, to: "fulfilling", actingUserId: user.id })
  );
  const afterFulfilling = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert(afterFulfilling.quantityOnHand === 7, `expected stock 7 after decrement, got ${afterFulfilling.quantityOnHand}`);
  const movements = await db.stockMovement.findMany({ where: { variantId: variant.id } });
  assert(movements.length === 1 && movements[0].delta === -3, "expected one -3 StockMovement audit row");
  console.log("✓ transitioned to fulfilling — stock atomically decremented 10 -> 7, audit row written");

  await db.$transaction((tx) =>
    transitionOrder(tx, { tenantId: tenant.id, storeId: store.id, orderId: order.id, to: "fulfilled", actingUserId: user.id })
  );
  const delivery = await db.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
  assert(delivery.status === "assigned", "delivery should start as assigned");
  console.log("✓ transitioned to fulfilled — delivery record created (assigned)");

  assert(canTransitionDelivery("assigned", "out_for_delivery"), "assigned -> out_for_delivery should be allowed");
  assert(!canTransitionDelivery("assigned", "delivered"), "assigned -> delivered should NOT be allowed (must go via out_for_delivery)");
  await db.delivery.update({ where: { id: delivery.id }, data: { status: "out_for_delivery" } });
  await db.delivery.update({ where: { id: delivery.id }, data: { status: "delivered" } });
  console.log("✓ delivery state machine enforced; delivery -> out_for_delivery -> delivered");

  // Cancelling a fulfilled order should be rejected by the state machine.
  let rejected = false;
  try {
    await db.$transaction((tx) =>
      transitionOrder(tx, { tenantId: tenant.id, storeId: store.id, orderId: order.id, to: "cancelled", actingUserId: user.id })
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "cancelling a fulfilled order should be rejected");
  console.log("✓ cancelling a fulfilled order is correctly rejected");

  await cleanupTenant(tenant.id);
  console.log("\nAll smoke tests passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
