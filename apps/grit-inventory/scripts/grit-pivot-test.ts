import "dotenv/config";
import { testDb as db, cleanupTenant } from "./db-test-client";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import { transitionTransfer, canTransitionTransfer } from "@/lib/transfers";

/**
 * Ad-hoc end-to-end test for the Grit BizSuite pivot:
 * multi-store StoreStock (aggregate maintenance, per-store locking) ->
 * FIFO lots (restock creates, consumption drains oldest-first, fallback
 * costing) -> transfer orders (dispatch/receive/cancel with cost carry) ->
 * COGS source records (StockLotConsumption).
 *
 * Run with: DATABASE_URL=<local-or-throwaway-db> npx tsx scripts/grit-pivot-test.ts
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const run = `pivot-${Date.now()}`;

  const tenant = await db.tenant.create({
    data: { name: `Pivot Test ${run}`, slug: run, tier: "SCALE" },
  });
  const mainStore = await db.store.create({
    data: { tenantId: tenant.id, name: "Main Store", isDefault: true, type: "retail" },
  });
  const warehouse = await db.store.create({
    data: { tenantId: tenant.id, name: "Warehouse", isDefault: false, type: "warehouse" },
  });
  const product = await db.product.create({
    data: { tenantId: tenant.id, name: "Pivot Widget", supplierName: "Acme Supply Co" },
  });
  const variant = await db.variant.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      sku: `PIVOT-${run}`,
      name: "Standard",
      price: 20,
      unitCost: 5,
      quantityOnHand: 0,
      reorderThreshold: 2,
    },
  });
  console.log("✓ created SCALE tenant with default store + warehouse");

  // --- Restocks create FIFO lots at two different costs -------------------
  await db.$transaction((tx) =>
    applyStockMovement(tx, {
      tenantId: tenant.id,
      storeId: mainStore.id,
      variantId: variant.id,
      delta: 10,
      reason: "restock",
      unitCost: 4,
    })
  );
  await db.$transaction((tx) =>
    applyStockMovement(tx, {
      tenantId: tenant.id,
      variantId: variant.id, // no storeId -> default store
      delta: 10,
      reason: "restock",
      unitCost: 6,
    })
  );
  let lots = await db.stockLot.findMany({
    where: { tenantId: tenant.id, variantId: variant.id },
    orderBy: { receivedAt: "asc" },
  });
  assert(lots.length === 2, `expected 2 lots, got ${lots.length}`);
  assert(
    lots.every((l) => l.storeId === mainStore.id),
    "omitted storeId should target the default store"
  );
  let v = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert(v.quantityOnHand === 20, `aggregate should be 20, got ${v.quantityOnHand}`);
  const mainStock = await db.storeStock.findUniqueOrThrow({
    where: {
      tenantId_storeId_variantId: {
        tenantId: tenant.id,
        storeId: mainStore.id,
        variantId: variant.id,
      },
    },
  });
  assert(mainStock.quantityOnHand === 20, "default-store StoreStock should be 20");
  console.log("✓ restocks created 2 FIFO lots (cost 4 then 6); aggregate + StoreStock = 20");

  // --- Consumption drains oldest lot first --------------------------------
  const sale = await db.$transaction((tx) =>
    applyStockMovement(tx, {
      tenantId: tenant.id,
      storeId: mainStore.id,
      variantId: variant.id,
      delta: -12,
      reason: "pos_sale",
    })
  );
  assert(sale.fifo, "consuming movement should report FIFO breakdown");
  // 10 @ 4 + 2 @ 6 = 52
  assert(
    Math.abs(sale.fifo.costConsumed - 52) < 1e-9,
    `FIFO cost should be 52 (10@4 + 2@6), got ${sale.fifo.costConsumed}`
  );
  lots = await db.stockLot.findMany({
    where: { tenantId: tenant.id, variantId: variant.id },
    orderBy: { receivedAt: "asc" },
  });
  assert(lots[0].quantityRemaining === 0 && lots[1].quantityRemaining === 8, "oldest lot drained first");
  const consumptions = await db.stockLotConsumption.findMany({
    where: { tenantId: tenant.id, variantId: variant.id },
  });
  assert(consumptions.length === 2, "one consumption row per drained lot");
  console.log("✓ -12 pos_sale drained oldest-first: cost 52, lot remainders 0 and 8");

  // --- Store isolation: warehouse has nothing to sell ---------------------
  let rejected = false;
  try {
    await db.$transaction((tx) =>
      applyStockMovement(tx, {
        tenantId: tenant.id,
        storeId: warehouse.id,
        variantId: variant.id,
        delta: -1,
        reason: "manual_adjustment",
      })
    );
  } catch (err) {
    rejected = err instanceof InsufficientStockError;
  }
  assert(rejected, "decrement at empty warehouse must throw InsufficientStockError");
  console.log("✓ per-store isolation: warehouse decrement rejected while main store holds 8");

  // --- allowNegative (POS ingestion) --------------------------------------
  const oversell = await db.$transaction((tx) =>
    applyStockMovement(tx, {
      tenantId: tenant.id,
      storeId: warehouse.id,
      variantId: variant.id,
      delta: -3,
      reason: "pos_sale",
      allowNegative: true,
    })
  );
  assert(oversell.storeQuantity === -3, "allowNegative should permit going below zero");
  assert(oversell.fifo && oversell.fifo.missingLotQuantity === 3, "missing lots fall back, never block");
  // put it back to zero for clean transfer math
  await db.$transaction((tx) =>
    applyStockMovement(tx, {
      tenantId: tenant.id,
      storeId: warehouse.id,
      variantId: variant.id,
      delta: 3,
      reason: "correction",
      unitCost: 0,
    })
  );
  console.log("✓ allowNegative POS ingestion records oversell with fallback costing");

  // --- Transfer order: draft -> in_transit -> received --------------------
  const transfer = await db.stockTransfer.create({
    data: {
      tenantId: tenant.id,
      fromStoreId: mainStore.id,
      toStoreId: warehouse.id,
      items: { create: [{ variantId: variant.id, quantity: 4 }] },
    },
  });
  assert(canTransitionTransfer("draft", "in_transit"), "draft -> in_transit allowed");
  assert(!canTransitionTransfer("draft", "received"), "draft -> received must be rejected");

  await db.$transaction((tx) =>
    transitionTransfer(tx, { tenantId: tenant.id, transferId: transfer.id, to: "in_transit" })
  );
  const afterDispatchMain = await db.storeStock.findUniqueOrThrow({
    where: {
      tenantId_storeId_variantId: {
        tenantId: tenant.id,
        storeId: mainStore.id,
        variantId: variant.id,
      },
    },
  });
  assert(afterDispatchMain.quantityOnHand === 4, `source should be 4 after dispatch, got ${afterDispatchMain.quantityOnHand}`);
  const dispatchedItem = await db.stockTransferItem.findFirstOrThrow({
    where: { transferId: transfer.id },
  });
  // Remaining lot was 8 @ 6 -> transfer of 4 carries unit cost 6.
  assert(Number(dispatchedItem.unitCost) === 6, `carried unit cost should be 6, got ${dispatchedItem.unitCost}`);

  const received = await db.$transaction((tx) =>
    transitionTransfer(tx, { tenantId: tenant.id, transferId: transfer.id, to: "received" })
  );
  assert(received.receivedItems?.length === 1 && received.receivedItems[0].quantity === 4, "received items reported for event publishing");
  const warehouseStock = await db.storeStock.findUniqueOrThrow({
    where: {
      tenantId_storeId_variantId: {
        tenantId: tenant.id,
        storeId: warehouse.id,
        variantId: variant.id,
      },
    },
  });
  assert(warehouseStock.quantityOnHand === 4, "destination should be 4 after receipt");
  const warehouseLot = await db.stockLot.findFirst({
    where: { tenantId: tenant.id, storeId: warehouse.id, quantityReceived: 4 },
  });
  assert(
    warehouseLot && Number(warehouseLot.unitCost) === 6,
    "receipt lot must carry the FIFO cost from the source"
  );
  v = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert(v.quantityOnHand === 8, `aggregate should still be 8 (4+4), got ${v.quantityOnHand}`);
  console.log("✓ transfer dispatched + received: 4 units moved, FIFO cost 6 carried, aggregate intact");

  // --- Cancellation from in_transit restores the source -------------------
  const transfer2 = await db.stockTransfer.create({
    data: {
      tenantId: tenant.id,
      fromStoreId: mainStore.id,
      toStoreId: warehouse.id,
      items: { create: [{ variantId: variant.id, quantity: 2 }] },
    },
  });
  await db.$transaction((tx) =>
    transitionTransfer(tx, { tenantId: tenant.id, transferId: transfer2.id, to: "in_transit" })
  );
  await db.$transaction((tx) =>
    transitionTransfer(tx, { tenantId: tenant.id, transferId: transfer2.id, to: "cancelled" })
  );
  const restoredMain = await db.storeStock.findUniqueOrThrow({
    where: {
      tenantId_storeId_variantId: {
        tenantId: tenant.id,
        storeId: mainStore.id,
        variantId: variant.id,
      },
    },
  });
  assert(restoredMain.quantityOnHand === 4, "cancelled in-transit transfer must restore the source");
  console.log("✓ in-transit cancellation restored the source store");

  // --- COGS source records -------------------------------------------------
  const cogsRows = await db.stockLotConsumption.findMany({
    where: { tenantId: tenant.id, movement: { reason: "pos_sale" } },
  });
  const cogs = cogsRows.reduce((sum, r) => sum + r.quantity * Number(r.unitCost), 0);
  // 52 from the lot-drained sale + 3 oversold units fallback-costed at the
  // variant unitCost of 5.
  assert(Math.abs(cogs - 67) < 1e-9, `pos_sale COGS should be 67 (52 + 3*5), got ${cogs}`);
  console.log("✓ StockLotConsumption rows reproduce FIFO COGS = 67 for pos_sale (incl. fallback)");

  await cleanupTenant(tenant.id);
  console.log("\nAll Grit pivot tests passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
