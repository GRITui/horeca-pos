"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type SubGroupRow = {
  id: string;
  name: string;
  sortOrder: number;
  _count: { products: number };
};

export type GroupRow = {
  id: string;
  name: string;
  sortOrder: number;
  subGroups: SubGroupRow[];
};

type AssignedProduct = {
  id: string;
  name: string;
  supplierName: string | null;
  isActive: boolean;
};

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

const smallButtonClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

async function readJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Rename + reorder controls shared by group and sub-group rows. */
function ReorderRenameControls({
  name,
  isFirst,
  isLast,
  busy,
  onRename,
  onMove,
}: {
  name: string;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onMove: (direction: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    // Keep the rename draft in sync with the latest server-confirmed name
    // (e.g. after a sibling reorder refresh) as long as the field isn't
    // being actively edited.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(name);
  }, [name]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onMove("up")}
        disabled={busy || isFirst}
        className={smallButtonClass}
        aria-label="Move up"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => onMove("down")}
        disabled={busy || isLast}
        className={smallButtonClass}
        aria-label="Move down"
      >
        ↓
      </button>
      {editing ? (
        <span className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={inputClass}
            autoFocus
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={async () => {
              await onRename(draft.trim());
              setEditing(false);
            }}
            className="text-sm font-medium text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setEditing(false);
            }}
            className="text-sm text-zinc-500 hover:underline"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm text-zinc-500 hover:underline"
        >
          Rename
        </button>
      )}
    </div>
  );
}

/** Search-and-assign + list-and-remove panel for one sub-group's products.
 * This is the only place product↔group assignment happens. */
function ProductsPanel({ subGroupId }: { subGroupId: string }) {
  const router = useRouter();
  const [assigned, setAssigned] = useState<AssignedProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssignedProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadAssigned() {
    const res = await fetch(`/api/item-sub-groups/${subGroupId}/products`);
    const data = await readJson(res);
    if (res.ok) setAssigned(data?.products ?? []);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount/subGroup change
    loadAssigned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subGroupId]);

  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const res = await fetch(`/api/products?q=${encodeURIComponent(query.trim())}`);
      const data = await readJson(res);
      setResults(res.ok ? (data?.products ?? []) : []);
      setSearching(false);
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  const assignedIds = new Set((assigned ?? []).map((p) => p.id));

  async function assign(productId: string) {
    setBusyId(productId);
    setError(null);
    try {
      const res = await fetch(`/api/item-sub-groups/${subGroupId}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not assign product");
        return;
      }
      await loadAssigned();
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function unassign(productId: string) {
    setBusyId(productId);
    setError(null);
    try {
      const res = await fetch(`/api/item-sub-groups/${subGroupId}/products`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not remove product");
        return;
      }
      await loadAssigned();
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Products in this group
        </h4>
        {assigned === null ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : assigned.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No products assigned yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {assigned.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="min-w-0 truncate text-zinc-900 dark:text-zinc-50">
                  {p.name}
                  {!p.isActive && <span className="ml-2 text-xs text-zinc-400">(inactive)</span>}
                </span>
                <button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => unassign(p.id)}
                  className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Add a product
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products by name…"
          className={`mt-1 w-full ${inputClass}`}
        />
        {searching && <p className="mt-1 text-xs text-zinc-500">Searching…</p>}
        {!searching && query.trim() && results.length === 0 && (
          <p className="mt-1 text-xs text-zinc-500">No matching products.</p>
        )}
        {results.length > 0 && (
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {results.map((p) => {
              const already = assignedIds.has(p.id);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span className="min-w-0 truncate text-zinc-900 dark:text-zinc-50">{p.name}</span>
                  <button
                    type="button"
                    disabled={already || busyId === p.id}
                    onClick={() => assign(p.id)}
                    className="shrink-0 text-xs font-medium text-zinc-900 hover:underline disabled:opacity-40 dark:text-zinc-50"
                  >
                    {already ? "Added" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function SubGroupItem({
  subGroup,
  isFirst,
  isLast,
}: {
  subGroup: SubGroupRow;
  isFirst: boolean;
  isLast: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProducts, setShowProducts] = useState(false);

  async function rename(name: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-sub-groups/${subGroup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Rename failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function move(direction: "up" | "down") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-sub-groups/${subGroup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Reorder failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (subGroup._count.products > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-sub-groups/${subGroup.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Delete failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReorderRenameControls
          name={subGroup.name}
          isFirst={isFirst}
          isLast={isLast}
          busy={busy}
          onRename={rename}
          onMove={move}
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {subGroup._count.products} product{subGroup._count.products === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => setShowProducts((v) => !v)}
            className="text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
          >
            {showProducts ? "Hide products" : "Products"}
          </button>
          <button
            type="button"
            disabled={busy || subGroup._count.products > 0}
            onClick={remove}
            title={
              subGroup._count.products > 0
                ? "Remove all assigned products before deleting"
                : undefined
            }
            className="text-sm font-medium text-red-600 hover:underline disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {showProducts && <ProductsPanel subGroupId={subGroup.id} />}
    </li>
  );
}

function NewSubGroupForm({ groupId }: { groupId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Sub-group name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-groups/${groupId}/sub-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not create sub-group");
        return;
      }
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New sub-group name"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {busy ? "Adding…" : "+ Sub-group"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

function GroupItem({ group, isFirst, isLast }: { group: GroupRow; isFirst: boolean; isLast: boolean }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(name: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Rename failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function move(direction: "up" | "down") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Reorder failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (group.subGroups.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-groups/${group.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Delete failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-zinc-500"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <ReorderRenameControls
            name={group.name}
            isFirst={isFirst}
            isLast={isLast}
            busy={busy}
            onRename={rename}
            onMove={move}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {group.subGroups.length} sub-group{group.subGroups.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            disabled={busy || group.subGroups.length > 0}
            onClick={remove}
            title={
              group.subGroups.length > 0 ? "Delete all sub-groups before deleting the group" : undefined
            }
            className="text-sm font-medium text-red-600 hover:underline disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
      {error && <p className="px-4 pb-2 text-xs text-red-600">{error}</p>}
      {expanded && (
        <div className="space-y-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
          {group.subGroups.length === 0 ? (
            <p className="text-sm text-zinc-500">No sub-groups yet.</p>
          ) : (
            <ul className="space-y-2">
              {group.subGroups.map((sg, i) => (
                <SubGroupItem
                  key={sg.id}
                  subGroup={sg}
                  isFirst={i === 0}
                  isLast={i === group.subGroups.length - 1}
                />
              ))}
            </ul>
          )}
          <NewSubGroupForm groupId={group.id} />
        </div>
      )}
    </div>
  );
}

function NewGroupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Group name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/item-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not create group");
        return;
      }
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          New item group
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Beverages"
          className={`mt-1 ${inputClass}`}
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {busy ? "Creating…" : "Create group"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function GroupsManager({ groups }: { groups: GroupRow[] }) {
  return (
    <div className="space-y-4">
      <NewGroupForm />
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No item groups yet.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group, i) => (
            <GroupItem key={group.id} group={group} isFirst={i === 0} isLast={i === groups.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}
