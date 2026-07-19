import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const createSubGroupSchema = z.object({
  name: z.string().min(1),
});

/** POST /api/item-groups/[id]/sub-groups — create a sub-group under this
 * group, appended to the end of the group's sort order. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const group = await db.itemGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!group) return apiError("Group not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = createSubGroupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid sub-group");
  }

  const max = await db.itemSubGroup.aggregate({
    where: { groupId: group.id },
    _max: { sortOrder: true },
  });

  try {
    const subGroup = await db.itemSubGroup.create({
      data: {
        tenantId: ctx.local.tenantId,
        groupId: group.id,
        name: parsed.data.name,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
    });
    return NextResponse.json({ subGroup }, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A sub-group with that name already exists in this group", 409);
    }
    throw err;
  }
}
