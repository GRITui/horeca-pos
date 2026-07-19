import type { Prisma } from "@/generated/prisma/client";

type TxClient = Prisma.TransactionClient;

export class StoreNotFoundError extends Error {
  constructor(tenantId: string, storeId?: string) {
    super(
      storeId
        ? `Store ${storeId} not found for tenant ${tenantId}`
        : `No default store found for tenant ${tenantId}`
    );
  }
}

/**
 * The tenant's default store — the target of every stock operation that does
 * not name a store explicitly (M1 behavior preserved). M1 guarantees exactly
 * one store per tenant with `isDefault = true`; if several exist the oldest
 * wins deterministically.
 */
export async function getDefaultStore(tx: TxClient, tenantId: string) {
  const store = await tx.store.findFirst({
    where: { tenantId, isDefault: true },
    orderBy: { createdAt: "asc" },
  });
  if (!store) throw new StoreNotFoundError(tenantId);
  return store;
}

/**
 * Resolves an optional store id to a concrete store owned by the tenant,
 * falling back to the tenant's default store when absent.
 */
export async function resolveStore(tx: TxClient, tenantId: string, storeId?: string | null) {
  if (!storeId) return getDefaultStore(tx, tenantId);
  const store = await tx.store.findFirst({ where: { id: storeId, tenantId } });
  if (!store) throw new StoreNotFoundError(tenantId, storeId);
  return store;
}
