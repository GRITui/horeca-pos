"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

export type LocationVariantOption = {
  id: string;
  sku: string;
  name: string;
  productName: string;
};

export type LocationRow = {
  id: string;
  code: string;
  zone: string | null;
  notes: string | null;
  isPrimary: boolean;
  variant: { id: string; sku: string; name: string; productName: string };
};

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

function PrimaryBadge({ isPrimary }: { isPrimary: boolean }) {
  if (!isPrimary) return <span className="text-zinc-400">—</span>;
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
      primary
    </span>
  );
}

/** Row editor: inline edit of code/zone/notes/isPrimary, plus delete. */
function LocationRowItem({ location }: { location: LocationRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(location.code);
  const [zone, setZone] = useState(location.zone ?? "");
  const [notes, setNotes] = useState(location.notes ?? "");
  const [isPrimary, setIsPrimary] = useState(location.isPrimary);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!code.trim()) {
      setError("Code is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/variant-locations/${location.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          zone: zone.trim() || null,
          notes: notes.trim() || null,
          isPrimary,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Update failed");
        return;
      }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove location ${location.code} for ${location.variant.sku}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/variant-locations/${location.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Delete failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
      <td className="px-4 py-3 font-mono text-zinc-900 dark:text-zinc-50">{location.variant.sku}</td>
      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
        {location.variant.productName} — {location.variant.name}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <input value={code} onChange={(e) => setCode(e.target.value)} className={`${inputClass} w-32`} />
        ) : (
          <span className="font-mono text-zinc-900 dark:text-zinc-50">{location.code}</span>
        )}
      </td>
      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
        {editing ? (
          <input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="zone"
            className={`${inputClass} w-28`}
          />
        ) : (
          location.zone ?? "—"
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <label className="inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            primary
          </label>
        ) : (
          <PrimaryBadge isPrimary={location.isPrimary} />
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex flex-col items-end gap-1">
          <span className="inline-flex gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="text-sm font-medium text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setCode(location.code);
                    setZone(location.zone ?? "");
                    setNotes(location.notes ?? "");
                    setIsPrimary(location.isPrimary);
                    setError(null);
                  }}
                  className="text-sm text-zinc-500 hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={remove}
                  className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </>
            )}
          </span>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </td>
    </tr>
  );
}

/** Assignment form: search a variant by SKU/name, then add a location row for it. */
function AssignLocationForm({
  storeId,
  variants,
  presetVariantId,
}: {
  storeId: string;
  variants: LocationVariantOption[];
  presetVariantId: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(presetVariantId);
  const [code, setCode] = useState("");
  const [zone, setZone] = useState("");
  const [isPrimary, setIsPrimary] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return variants
      .filter(
        (v) =>
          v.sku.toLowerCase().includes(q) ||
          v.name.toLowerCase().includes(q) ||
          v.productName.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [query, variants]);

  const selectedVariant = variants.find((v) => v.id === selectedVariantId) ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedVariantId) {
      setError("Search and pick a variant first");
      return;
    }
    if (!code.trim()) {
      setError("Code is required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/variant-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          variantId: selectedVariantId,
          code: code.trim(),
          zone: zone.trim() || undefined,
          isPrimary,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not add location");
        return;
      }
      setCode("");
      setZone("");
      setIsPrimary(true);
      setSelectedVariantId(null);
      setQuery("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Assign a location</h3>

      {selectedVariant ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Variant:</span>
          <span className="font-medium text-zinc-900 dark:text-zinc-50">
            {selectedVariant.productName} — {selectedVariant.name} ({selectedVariant.sku})
          </span>
          <button
            type="button"
            onClick={() => {
              setSelectedVariantId(null);
              setQuery("");
            }}
            className="text-sm text-zinc-500 hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Search variant by SKU or name
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. WIDGET-01 or Blue widget"
            className={`mt-1 w-full max-w-sm ${inputClass}`}
          />
          {query.trim() !== "" && (
            <div className="mt-1 max-w-sm divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-700">
              {matches.length === 0 ? (
                <p className="px-3 py-2 text-sm text-zinc-500">No matching variants.</p>
              ) : (
                matches.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      setSelectedVariantId(v.id);
                      setQuery("");
                    }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">
                      {v.productName} — {v.name}
                    </span>{" "}
                    <span className="font-mono text-zinc-500">({v.sku})</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Code</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="A1-03-02"
            className={`mt-1 w-36 ${inputClass}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Zone</label>
          <input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="optional"
            className={`mt-1 w-32 ${inputClass}`}
          />
        </div>
        <label className="mb-2 inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          primary
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || !selectedVariantId}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {busy ? "Adding…" : "Add location"}
      </button>
    </form>
  );
}

export function LocationsManager({
  storeId,
  storeName,
  locations,
  variants,
}: {
  storeId: string;
  storeName: string;
  locations: LocationRow[];
  variants: LocationVariantOption[];
}) {
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanFilter, setScanFilter] = useState<{ variantId: string; sku: string; name: string } | null>(
    null
  );
  const [scanNotFound, setScanNotFound] = useState<string | null>(null);

  useBarcodeScanner({
    onScan: async (code) => {
      setScanStatus(`Scanned ${code}…`);
      setScanNotFound(null);
      try {
        const res = await fetch(`/api/variants/lookup?sku=${encodeURIComponent(code)}`);
        if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
        const data = (await res.json()) as {
          variant: { id: string; sku: string; name: string } | null;
        };
        if (data.variant) {
          setScanFilter({ variantId: data.variant.id, sku: data.variant.sku, name: data.variant.name });
          setScanStatus(null);
        } else {
          setScanFilter(null);
          setScanStatus(null);
          setScanNotFound(code);
        }
      } catch {
        setScanStatus(null);
        setScanNotFound(code);
      }
    },
  });

  const visibleLocations = scanFilter
    ? locations.filter((l) => l.variant.id === scanFilter.variantId)
    : locations;

  return (
    <div className="space-y-4">
      {scanStatus && (
        <div className="fixed bottom-4 right-4 z-20 rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <span className="text-zinc-600 dark:text-zinc-300">{scanStatus}</span>
        </div>
      )}

      {scanFilter && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-300 bg-zinc-50 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <span className="text-zinc-700 dark:text-zinc-300">
            Showing locations for <span className="font-mono font-medium">{scanFilter.sku}</span> —{" "}
            {scanFilter.name} at {storeName}
          </span>
          <button
            type="button"
            onClick={() => setScanFilter(null)}
            className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
          >
            Clear
          </button>
        </div>
      )}

      {scanNotFound && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <span>
            No such SKU: <span className="font-mono font-medium">{scanNotFound}</span>
          </span>
          <button type="button" onClick={() => setScanNotFound(null)} className="font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <AssignLocationForm storeId={storeId} variants={variants} presetVariantId={scanFilter?.variantId ?? null} />

      {visibleLocations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {scanFilter
            ? `No locations assigned for ${scanFilter.sku} at ${storeName} yet.`
            : `No locations assigned at ${storeName} yet.`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Product / variant</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Zone</th>
                <th className="px-4 py-3 font-medium">Primary</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleLocations.map((location) => (
                <LocationRowItem key={location.id} location={location} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
