// ---------------------------------------------------------------------------
// Offline-first queue for the staff register — hand-rolled IndexedDB, no
// dependencies. Stores operations that failed with a NETWORK error so they
// can be replayed (in capture order) against POST /api/orders/offline-sync,
// which dedupes on each op's client-generated `externalRef` (uuid).
//
// Browser-only: every function no-ops safely when IndexedDB is unavailable
// (SSR, ancient browsers), so importing this from client components that
// render on the server is fine.
// ---------------------------------------------------------------------------

export interface QueuedLineInput {
  productId: string;
  variantId: string | null;
  addOnIds: string[];
  quantity: number;
}

/** A tender captured offline against an existing open order. */
export interface QueuedTenderOp {
  kind: "tender";
  externalRef: string;
  orderId: string;
  tenderType: "cash" | "card" | "qr_pay";
  amount: number;
  queuedAt: string;
}

/** A full offline quick sale: order + lines + cash tender in one op. */
export interface QueuedQuickSaleOp {
  kind: "quick_sale";
  externalRef: string;
  lines: QueuedLineInput[];
  tenderType: "cash";
  amount: number;
  queuedAt: string;
}

export type QueuedOp = QueuedTenderOp | QueuedQuickSaleOp;

const DB_NAME = "grit-pos-offline";
const DB_VERSION = 1;
const STORE = "ops";

type QueueListener = (depth: number) => void;
const listeners = new Set<QueueListener>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export function newExternalRef(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ref-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // seq keeps strict capture order; externalRef is the dedupe key.
        const store = db.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        store.createIndex("externalRef", "op.externalRef", { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

async function notifyListeners(): Promise<void> {
  const depth = await queueDepth();
  for (const listener of listeners) listener(depth);
}

/** Appends an op to the queue. Resolves to the current queue depth. */
export async function enqueueOp(op: QueuedOp): Promise<number> {
  if (!hasIndexedDb()) return 0;
  await withStore("readwrite", (store) => requestToPromise(store.add({ op })));
  const depth = await queueDepth();
  for (const listener of listeners) listener(depth);
  return depth;
}

/** All queued ops, oldest first (capture order). */
export async function listOps(): Promise<QueuedOp[]> {
  if (!hasIndexedDb()) return [];
  const rows = await withStore("readonly", (store) =>
    requestToPromise(store.getAll() as IDBRequest<Array<{ seq: number; op: QueuedOp }>>),
  );
  return rows.sort((a, b) => a.seq - b.seq).map((row) => row.op);
}

/** Removes ops whose externalRef is in `refs` (after a successful replay). */
export async function removeOps(refs: string[]): Promise<void> {
  if (!hasIndexedDb() || refs.length === 0) return;
  const wanted = new Set(refs);
  await withStore("readwrite", async (store) => {
    const rows = await requestToPromise(
      store.getAll() as IDBRequest<Array<{ seq: number; op: QueuedOp }>>,
    );
    for (const row of rows) {
      if (wanted.has(row.op.externalRef)) {
        await requestToPromise(store.delete(row.seq));
      }
    }
  });
  await notifyListeners();
}

/** Number of ops waiting to sync. */
export async function queueDepth(): Promise<number> {
  if (!hasIndexedDb()) return 0;
  return withStore("readonly", (store) => requestToPromise(store.count()));
}

/** Subscribe to queue-depth changes; returns an unsubscribe function. */
export function onQueueChange(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
