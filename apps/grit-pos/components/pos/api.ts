"use client";

import type { OrderDTO } from "./types";
import {
  enqueueOp,
  listOps,
  newExternalRef,
  removeOps,
  type QueuedLineInput,
  type QueuedOp,
} from "./offlineQueue";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/**
 * A fetch() rejection (TypeError) means the network itself failed — the
 * offline-capture path. HTTP-level errors (4xx/5xx) reach us as normal
 * `Error`s from request() and must NOT be queued: the server saw the request
 * and rejected it, so replaying it verbatim would fail again.
 */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function createOrder(tableId: string | null): Promise<{ order: OrderDTO }> {
  return request("/api/orders", {
    method: "POST",
    body: JSON.stringify({ tableId }),
  });
}

export function cancelOrder(orderId: string): Promise<{ order: OrderDTO | null }> {
  return request(`/api/orders/${orderId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
  });
}

export function addOrderLine(
  orderId: string,
  input: { productId: string; variantId: string | null; addOnIds: string[]; quantity: number },
): Promise<{ order: OrderDTO }> {
  return request(`/api/orders/${orderId}/lines`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOrderLineQuantity(
  orderId: string,
  lineId: string,
  quantity: number,
): Promise<{ order: OrderDTO }> {
  return request(`/api/orders/${orderId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify({ quantity }),
  });
}

export function removeOrderLine(orderId: string, lineId: string): Promise<{ order: OrderDTO }> {
  return request(`/api/orders/${orderId}/lines/${lineId}`, { method: "DELETE" });
}

export type TenderResult =
  | { queued: false; order: OrderDTO; changeDue: number }
  | { queued: true; externalRef: string };

/**
 * Records a tender. When the network is down and offline mode is allowed
 * (`pos.offline_mode` entitlement, passed in by the caller), the tender is
 * captured into the IndexedDB queue instead and replayed later via
 * POST /api/orders/offline-sync — the result then carries `queued: true`.
 */
export async function tenderOrder(
  orderId: string,
  input: { tenderType: "cash" | "card" | "qr_pay"; amount: number },
  options: { queueOffline?: boolean } = {},
): Promise<TenderResult> {
  try {
    const data = await request<{ order: OrderDTO; changeDue: number }>(
      `/api/orders/${orderId}/tender`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return { queued: false, ...data };
  } catch (err) {
    if (!options.queueOffline || !isNetworkError(err)) throw err;
    const externalRef = newExternalRef();
    await enqueueOp({
      kind: "tender",
      externalRef,
      orderId,
      tenderType: input.tenderType,
      amount: input.amount,
      queuedAt: new Date().toISOString(),
    });
    return { queued: true, externalRef };
  }
}

export type QuickSaleResult =
  | { queued: false; orderId: string }
  | { queued: true; externalRef: string };

/**
 * Full "quick sale": create order + lines + cash tender in ONE idempotent op.
 * Always goes through /api/orders/offline-sync (online too) so the same
 * external_ref dedupe covers both paths; queues when the network is down.
 */
export async function submitQuickSale(
  lines: QueuedLineInput[],
  amount: number,
  options: { queueOffline?: boolean } = {},
): Promise<QuickSaleResult> {
  const op: QueuedOp = {
    kind: "quick_sale",
    externalRef: newExternalRef(),
    lines,
    tenderType: "cash",
    amount,
    queuedAt: new Date().toISOString(),
  };
  try {
    const data = await request<{ results: OfflineSyncResult[] }>("/api/orders/offline-sync", {
      method: "POST",
      body: JSON.stringify({ ops: [op] }),
    });
    const result = data.results[0];
    if (!result || result.status === "rejected") {
      throw new Error(result?.error ?? "Quick sale was rejected");
    }
    return { queued: false, orderId: result.orderId ?? "" };
  } catch (err) {
    if (!options.queueOffline || !isNetworkError(err)) throw err;
    await enqueueOp(op);
    return { queued: true, externalRef: op.externalRef };
  }
}

export interface OfflineSyncResult {
  externalRef: string;
  status: "applied" | "duplicate" | "rejected";
  orderId?: string;
  error?: string;
}

// Must not exceed the server's own cap (app/api/orders/offline-sync/route.ts
// MAX_OPS_PER_SYNC) — otherwise a queue that grows past the limit would get
// a 400 on every retry forever, since the client never chunks and the
// server rejects the whole oversized batch before touching any op.
const MAX_OPS_PER_SYNC = 100;

/**
 * Replays every queued op (in capture order) against the idempotent sync
 * endpoint, then drops the ops the server settled (applied, duplicate, or
 * permanently rejected — a rejected op can never succeed by retrying).
 * Network failures leave the queue untouched for the next attempt.
 *
 * Sent in chunks of at most MAX_OPS_PER_SYNC so a queue that grew past the
 * server's per-request cap can still make progress; a failure on one chunk
 * stops further chunks and leaves the rest of the queue for the next retry.
 * Returns the number of ops that remain queued.
 */
export async function syncOfflineQueue(): Promise<number> {
  const ops = await listOps();
  if (ops.length === 0) return 0;

  let remaining = ops.length;
  for (let i = 0; i < ops.length; i += MAX_OPS_PER_SYNC) {
    const chunk = ops.slice(i, i + MAX_OPS_PER_SYNC);
    const data = await request<{ results: OfflineSyncResult[] }>("/api/orders/offline-sync", {
      method: "POST",
      body: JSON.stringify({ ops: chunk }),
    });
    const settled = data.results.map((r) => r.externalRef);
    await removeOps(settled);
    remaining -= settled.length;
  }
  return remaining;
}
