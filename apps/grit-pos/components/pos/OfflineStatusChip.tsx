"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { syncOfflineQueue } from "./api";
import { onQueueChange, queueDepth } from "./offlineQueue";

const SYNC_INTERVAL_MS = 20_000;

/**
 * Small header chip showing the register's connectivity + offline-queue
 * depth. Also owns the replay loop: whenever the browser comes back online
 * (and on a slow interval as a safety net) it pushes queued ops to
 * POST /api/orders/offline-sync and refreshes the current route so
 * server-rendered order lists pick up the synced sales.
 *
 * Mounted only when the org is entitled to `pos.offline_mode`
 * (@grit/passport hasFeatureAccess — every tier today, but still gated).
 */
function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export default function OfflineStatusChip() {
  const router = useRouter();
  // navigator.onLine as an external store (SSR snapshot: online).
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [depth, setDepth] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if ((await queueDepth()) === 0) return;
    setSyncing(true);
    try {
      await syncOfflineQueue();
      router.refresh();
    } catch {
      // Still offline (or server unreachable) — the queue is untouched and
      // the next online event / interval tick will retry.
    } finally {
      setSyncing(false);
    }
  }, [router]);

  useEffect(() => {
    void queueDepth().then(setDepth);
    const unsubscribe = onQueueChange(setDepth);
    const timer = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
    // Deferred initial sync (never synchronously inside the effect body).
    const kickoff = setTimeout(() => void runSync(), 0);
    return () => {
      unsubscribe();
      clearInterval(timer);
      clearTimeout(kickoff);
    };
  }, [runSync]);

  // Replay the queue the moment connectivity returns.
  useEffect(() => {
    if (!online) return;
    const kickoff = setTimeout(() => void runSync(), 0);
    return () => clearTimeout(kickoff);
  }, [online, runSync]);

  const label = !online
    ? depth > 0
      ? `Offline · ${depth} queued`
      : "Offline"
    : syncing
      ? "Syncing…"
      : depth > 0
        ? `${depth} queued`
        : "Online";

  return (
    <span
      title="Offline-first register: sales captured while offline sync automatically."
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        !online
          ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : depth > 0
            ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
            : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          !online ? "bg-amber-500" : depth > 0 ? "bg-blue-500" : "bg-emerald-500"
        }`}
      />
      {label}
    </span>
  );
}
