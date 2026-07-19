"use client";

import { useEffect, useRef, useState } from "react";
import type { PickupOrderStatus } from "./types";

interface PickupConfirmationProps {
  tenantSlug: string;
  orderId: string;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 15; // ~30s — Stripe webhooks land in well under that normally

function formatPromisedTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * Shown at /pickup/[tenantSlug]/success after the Stripe Checkout redirect.
 * Payment confirmation is asynchronous (app/api/stripe/webhook/route.ts
 * flips the order to "tendered" once Stripe reports success), so this polls
 * app/api/pickup/[tenantSlug]/order/[orderId] until that lands.
 */
export function PickupConfirmation({ tenantSlug, orderId }: PickupConfirmationProps) {
  const [order, setOrder] = useState<PickupOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollCount = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/pickup/${tenantSlug}/order/${orderId}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (!res.ok) {
          setError(data.error ?? "Couldn't load your order.");
          return;
        }

        setOrder(data.order);
        pollCount.current += 1;

        if (!data.order.paid && pollCount.current < MAX_POLLS) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach the server. Please refresh to check your order.");
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tenantSlug, orderId]);

  if (error) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-zinc-500">
        <p>Loading your order…</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-6 text-center">
      <div className="text-4xl">{order.paid ? "✅" : "⏳"}</div>
      <h1 className="text-xl font-bold tracking-tight">
        {order.paid ? "Order confirmed!" : "Confirming your payment…"}
      </h1>

      {order.paid ? (
        <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
          {order.promisedAt
            ? `We'll have it ready for pickup around ${formatPromisedTime(order.promisedAt)}.`
            : "We're getting your order started."}
        </p>
      ) : (
        <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
          This can take a few seconds. Please don&apos;t close this page.
        </p>
      )}

      <div className="w-full max-w-sm rounded-lg border border-zinc-200 p-4 text-left text-sm dark:border-zinc-800">
        <ul className="flex flex-col gap-1">
          {order.lines.map((line) => (
            <li key={line.id} className="flex items-center justify-between gap-2">
              <span>
                {line.quantity}× {line.productName}
                {line.variantName ? ` (${line.variantName})` : ""}
                {line.addOns.length > 0 ? ` + ${line.addOns.map((a) => a.name).join(", ")}` : ""}
              </span>
              <span>{line.lineTotal.toFixed(2)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-2 font-semibold dark:border-zinc-800">
          <span>Total</span>
          <span>{order.total.toFixed(2)}</span>
        </div>
      </div>
    </main>
  );
}
