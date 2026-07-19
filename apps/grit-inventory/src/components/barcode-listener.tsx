"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

type VariantOption = {
  id: string;
  sku: string;
  name: string;
  productId: string;
  productName: string;
};

/**
 * Mounted on the products admin list: a keyboard-wedge barcode scan of a
 * known variant SKU jumps straight to that product; an unknown SKU opens a
 * quick "assign this barcode to a variant" flow.
 */
export function ProductsBarcodeListener() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [unknownSku, setUnknownSku] = useState<string | null>(null);
  const [options, setOptions] = useState<VariantOption[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useBarcodeScanner({
    enabled: unknownSku === null,
    onScan: async (code) => {
      setStatus(`Scanned ${code}…`);
      setError(null);
      try {
        const res = await fetch(`/api/variants/lookup?sku=${encodeURIComponent(code)}`);
        if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
        const data = (await res.json()) as { variant: { productId: string } | null };
        if (data.variant) {
          setStatus(null);
          router.push(`/admin/products/${data.variant.productId}`);
          return;
        }
        // Unknown SKU: offer assignment.
        const productsRes = await fetch("/api/products");
        const productsData = (await productsRes.json()) as {
          products: Array<{
            id: string;
            name: string;
            variants: Array<{ id: string; sku: string; name: string }>;
          }>;
        };
        const opts: VariantOption[] = productsData.products.flatMap((p) =>
          p.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            name: v.name,
            productId: p.id,
            productName: p.name,
          }))
        );
        setOptions(opts);
        setSelectedVariantId(opts[0]?.id ?? "");
        setUnknownSku(code);
        setStatus(null);
      } catch (err) {
        setStatus(null);
        setError(err instanceof Error ? err.message : "Scan lookup failed");
      }
    },
  });

  async function assignSku() {
    if (!unknownSku || !selectedVariantId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/variants/${selectedVariantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: unknownSku }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not assign SKU");
        return;
      }
      const target = options.find((o) => o.id === selectedVariantId);
      setUnknownSku(null);
      if (target) router.push(`/admin/products/${target.productId}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(status || error) && (
        <div className="fixed bottom-4 right-4 z-20 rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {status && <span className="text-zinc-600 dark:text-zinc-300">{status}</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      )}

      {unknownSku !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Unknown barcode
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              No variant has SKU <span className="font-mono font-medium">{unknownSku}</span>. Assign
              it to an existing variant?
            </p>
            {options.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">No variants available to assign.</p>
            ) : (
              <select
                value={selectedVariantId}
                onChange={(e) => setSelectedVariantId(e.target.value)}
                className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.productName} — {o.name} (current SKU {o.sku})
                  </option>
                ))}
              </select>
            )}
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setUnknownSku(null);
                  setError(null);
                }}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={assignSku}
                disabled={busy || options.length === 0}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
              >
                {busy ? "Assigning…" : "Assign SKU"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
