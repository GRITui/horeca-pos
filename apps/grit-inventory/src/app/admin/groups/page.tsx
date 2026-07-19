import { redirect } from "next/navigation";
import { hasFeatureAccess } from "@grit/passport";
import { db } from "@/lib/db";
import { getGritContext } from "@/lib/passport";
import { Card, PageHeader } from "@/components/ui";
import { GroupsManager } from "@/components/groups-manager";

export const dynamic = "force-dynamic";

/** Item groups / sub-groups (Grit BizSuite WMS epic). Gated on
 * `inventory.multi_location` (SCALE), the existing feature key this pass
 * reuses. Product↔group assignment happens entirely from here (the
 * sub-group's "Products in this group" panel) — the product pages
 * themselves don't expose it. */
export default async function GroupsPage() {
  const ctx = await getGritContext();
  if (!ctx) redirect("/login");

  if (!hasFeatureAccess(ctx.grit, "inventory.multi_location")) {
    return (
      <div>
        <PageHeader title="Groups" description="Categorize products into groups and sub-groups." />
        <Card>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Item groups are a SCALE feature
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Your current plan ({ctx.grit.tier}) doesn&apos;t include product categorization. Upgrade to
            SCALE to organize products into groups and sub-groups.
          </p>
        </Card>
      </div>
    );
  }

  const groups = await db.itemGroup.findMany({
    where: { tenantId: ctx.local.tenantId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      subGroups: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: { _count: { select: { products: true } } },
      },
    },
  });

  return (
    <div>
      <PageHeader
        title="Groups"
        description="Two-level product categorization. A group can't be deleted while it has sub-groups; a sub-group can't be deleted while products are assigned to it."
      />
      <GroupsManager
        groups={groups.map((g) => ({
          id: g.id,
          name: g.name,
          sortOrder: g.sortOrder,
          subGroups: g.subGroups.map((sg) => ({
            id: sg.id,
            name: sg.name,
            sortOrder: sg.sortOrder,
            _count: sg._count,
          })),
        }))}
      />
    </div>
  );
}
