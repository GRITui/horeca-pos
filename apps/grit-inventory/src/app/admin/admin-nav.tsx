"use client";

import { createContext, useContext, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Off-canvas drawer state for the admin sidebar, shared between the
 * hamburger trigger (in the header) and the sidebar itself (a sibling in
 * `layout.tsx`). Desktop (lg and up) never reads this — the sidebar is
 * always visible there via the base (non-`max-lg:`) classes.
 */
const NavDrawerContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

export function NavDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Close the drawer whenever the route changes (link click, back/forward).
  // Adjusting state during render (not in an effect) avoids the extra
  // render-then-effect-then-render cascade — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  return <NavDrawerContext.Provider value={{ open, setOpen }}>{children}</NavDrawerContext.Provider>;
}

function useNavDrawer() {
  const ctx = useContext(NavDrawerContext);
  if (!ctx) throw new Error("useNavDrawer must be used within NavDrawerProvider");
  return ctx;
}

/** Hamburger button — lives in the header, only rendered below `lg`. */
export function NavDrawerToggle() {
  const { open, setOpen } = useNavDrawer();
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label={open ? "Close navigation" : "Open navigation"}
      aria-expanded={open}
      className="-ml-1.5 hidden shrink-0 rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 max-lg:inline-flex dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
        {open ? (
          <path d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z" />
        ) : (
          <path
            fillRule="evenodd"
            d="M2.5 5.5a.75.75 0 0 1 .75-.75h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm0 4.5a.75.75 0 0 1 .75-.75h13.5a.75.75 0 0 1 0 1.5H3.25A.75.75 0 0 1 2.5 10Zm0 4.5a.75.75 0 0 1 .75-.75h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Z"
            clipRule="evenodd"
          />
        )}
      </svg>
    </button>
  );
}

/** Backdrop shown behind the drawer below `lg` while it is open. */
export function NavDrawerOverlay() {
  const { open, setOpen } = useNavDrawer();
  if (!open) return null;
  return (
    <div
      onClick={() => setOpen(false)}
      aria-hidden="true"
      className="fixed inset-0 z-30 bg-black/40 max-lg:block lg:hidden"
    />
  );
}

/**
 * The sidebar itself. Desktop-first: base classes are the original static
 * `flex w-56 shrink-0 flex-col ...` sidebar. `max-lg:` classes layer an
 * off-canvas drawer on top for tablet/mobile — fixed, off-screen by default,
 * slides in when the drawer is open.
 */
export function NavDrawerAside({
  navItems,
  sessionName,
  logoutSlot,
}: {
  navItems: Array<{ href: string; label: string }>;
  sessionName: string;
  logoutSlot: React.ReactNode;
}) {
  const { open, setOpen } = useNavDrawer();
  return (
    <aside
      className={`flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white transition-transform duration-200 dark:border-zinc-800 dark:bg-zinc-900 max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:w-64 max-lg:shadow-xl ${
        open ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Grit Inventory</p>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{sessionName}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
          className="hidden shrink-0 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 max-lg:inline-flex dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">{logoutSlot}</div>
    </aside>
  );
}
