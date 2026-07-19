import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError, requireTenant } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import SignOutButton from "@/components/pos/SignOutButton";

export default async function ReconciliationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let session;
  try {
    session = await requireTenant();
  } catch (err) {
    if (err instanceof AuthError) {
      redirect("/login");
    }
    throw err;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.tenantId },
    select: { name: true },
  });

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-semibold">{tenant?.name ?? "Horeca POS"}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{session.email}</p>
        </div>
        <nav className="flex items-center gap-4">
          <Link href="/pos" className="text-sm text-zinc-500 underline dark:text-zinc-400">
            POS
          </Link>
          <SignOutButton />
        </nav>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
