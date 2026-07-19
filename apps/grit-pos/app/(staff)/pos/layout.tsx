import Link from "next/link";
import { redirect } from "next/navigation";
import { AppSwitcher } from "@grit/shared-ui";
import { appsForSession, buildAppNav } from "@grit/passport";
import { AuthError, requireTenant } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getGritSession, sessionHasFeature } from "@/lib/passportBridge";
import SignOutButton from "@/components/pos/SignOutButton";
import OfflineStatusChip from "@/components/pos/OfflineStatusChip";

export default async function PosLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await requireTenant();
  } catch (err) {
    if (err instanceof AuthError) {
      redirect("/login");
    }
    throw err;
  }

  const [tenant, gritSession] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: session.tenantId },
      select: { name: true },
    }),
    // Grit Passport bridge: the horeca session stays the login; a GritSession
    // is derived from it for suite nav + tier gates (see lib/passportBridge.ts).
    getGritSession(),
  ]);

  // Only apps this user can actually open (org tier+addons ∩ role) — a LITE
  // org shows POS alone, so no layout panel ever links into inventory
  // networks the plan excludes.
  const navItems = gritSession
    ? buildAppNav(gritSession).filter((item) =>
        appsForSession(gritSession).includes(item.key),
      )
    : [];
  const offlineEnabled = sessionHasFeature(gritSession, "pos.offline_mode");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{tenant?.name ?? "Grit POS"}</p>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{session.email}</p>
          </div>
          {navItems.length > 0 && (
            <AppSwitcher items={navItems} currentApp="pos" className="hidden sm:block" />
          )}
        </div>
        <nav className="flex shrink-0 items-center gap-4">
          {offlineEnabled && <OfflineStatusChip />}
          <Link href="/reconciliation" className="text-sm text-zinc-500 underline dark:text-zinc-400">
            Reconciliation
          </Link>
          <SignOutButton />
        </nav>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
