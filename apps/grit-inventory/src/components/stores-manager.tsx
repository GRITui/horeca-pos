"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STORE_TYPES = ["retail", "warehouse", "service_hub", "kitchen"] as const;

export type StoreRow = {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
};

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

function TypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {STORE_TYPES.map((t) => (
        <option key={t} value={t}>
          {t.replace("_", " ")}
        </option>
      ))}
    </select>
  );
}

function StoreRowItem({ store }: { store: StoreRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(store.name);
  const [type, setType] = useState(store.type);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/stores/${store.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type }),
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

  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
      <td className="px-4 py-3">
        {editing ? (
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        ) : (
          <span className="font-medium text-zinc-900 dark:text-zinc-50">{store.name}</span>
        )}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
        {editing ? <TypeSelect value={type} onChange={setType} /> : store.type.replace("_", " ")}
      </td>
      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
        {store.isDefault ? (
          <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            default
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <span className="inline-flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-sm text-zinc-500 hover:underline"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="text-sm font-medium text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
          >
            Rename
          </button>
        )}
      </td>
    </tr>
  );
}

export function StoresManager({ stores }: { stores: StoreRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("retail");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createStore(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Store name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create store");
        return;
      }
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-3 font-medium">Store</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Default</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => (
              <StoreRowItem key={store.id} store={store} />
            ))}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={createStore}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            New store name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Riverside Warehouse"
            className={`mt-1 ${inputClass}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
          <div className="mt-1">
            <TypeSelect value={type} onChange={setType} />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {busy ? "Creating…" : "Create store"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
