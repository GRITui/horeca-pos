import { redirect } from "next/navigation";
import { buildAppNav, hasFeatureAccess } from "@grit/passport";
import { AppSwitcher } from "@grit/shared-ui";
import { getGritContext } from "@/lib/passport";
import { LogoutButton } from "@/components/logout-button";
import { NavDrawerAside, NavDrawerOverlay, NavDrawerProvider, NavDrawerToggle } from "./admin-nav";

const NAV_ITEMS = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/deliveries", label: "Deliveries" },
  { href: "/admin/reports", label: "Reports" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getGritContext();
  if (!ctx) {
    redirect("/login");
  }
  const { local: session, grit } = ctx;

  const navItems = [...NAV_ITEMS];
  // Multi-location surfaces are hidden below SCALE (GROWTH is gated from
  // reading multiple location tables); the pages themselves also gate.
  if (hasFeatureAccess(grit, "inventory.multi_location")) {
    navItems.splice(2, 0, { href: "/admin/stores", label: "Stores" });
  }
  if (hasFeatureAccess(grit, "inventory.transfers")) {
    navItems.splice(3, 0, { href: "/admin/transfers", label: "Transfers" });
  }
  // Item groups (Grit BizSuite WMS epic) reuses the same SCALE gate as
  // stores/transfers rather than introducing a new feature key.
  if (hasFeatureAccess(grit, "inventory.multi_location")) {
    navItems.splice(navItems.findIndex((item) => item.href === "/admin/products") + 1, 0, {
      href: "/admin/groups",
      label: "Groups",
    });
  }
  if (hasFeatureAccess(grit, "inventory.multi_location")) {
    navItems.splice(4, 0, { href: "/admin/locations", label: "Locations" });
  }
  // Promotions (Grit BizSuite pivot) reuses the same SCALE gate rather than
  // introducing a new feature key.
  if (hasFeatureAccess(grit, "inventory.multi_location")) {
    navItems.splice(navItems.findIndex((item) => item.href === "/admin/locations") + 1, 0, {
      href: "/admin/promotions",
      label: "Promotions",
    });
  }

  const appNav = buildAppNav(grit);

  return (
    <NavDrawerProvider>
      <div className="flex min-h-screen flex-1 bg-zinc-50 dark:bg-zinc-950">
        <NavDrawerOverlay />
        <NavDrawerAside navItems={navItems} sessionName={session.name} logoutSlot={<LogoutButton />} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <NavDrawerToggle />
            <AppSwitcher items={appNav} currentApp="inventory" className="min-w-0" />
          </header>
          <main className="flex-1 overflow-x-hidden p-6 max-md:p-4">{children}</main>
        </div>
      </div>
    </NavDrawerProvider>
  );
}
