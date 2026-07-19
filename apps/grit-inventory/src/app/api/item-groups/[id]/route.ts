import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const updateGroupSchema = z.object({
  name: z.string().min(1).optional(),
  direction: z.enum(["up", "down"]).optional(),
});

/** PATCH /api/item-groups/[id] — rename and/or reorder (swap sortOrder with
 * the previous/next sibling group, atomically). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const parsed = updateGroupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const { name, direction } = parsed.data;
  if (!name && !direction) return apiError("Nothing to update");

  try {
    await db.$transaction(async (tx) => {
      if (name) {
        await tx.itemGroup.update({ where: { id: group.id }, data: { name } });
      }
      if (direction) {
        const siblings = await tx.itemGroup.findMany({
          where: { tenantId: ctx.local.tenantId },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, sortOrder: true },
        });
        const idx = siblings.findIndex((s) => s.id === group.id);
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return;
        const current = siblings[idx];
        const swapWith = siblings[swapIdx];
        await tx.itemGroup.update({ where: { id: current.id }, data: { sortOrder: swapWith.sortOrder } });
        await tx.itemGroup.update({ where: { id: swapWith.id }, data: { sortOrder: current.sortOrder } });
      }
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A group with that name already exists", 409);
    }
    throw err;
  }

  const updated = await db.itemGroup.findUniqueOrThrow({
    where: { id: group.id },
    include: { subGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
  });
  return NextResponse.json({ group: updated });
}

/** DELETE /api/item-groups/[id] — refuses (409) while the group still has
 * any sub-groups; delete those first. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const subGroupCount = await db.itemSubGroup.count({ where: { groupId: group.id } });
  if (subGroupCount > 0) {
    return apiError("Group still has sub-groups — delete those first", 409);
  }

  await db.itemGroup.delete({ where: { id: group.id } });
  return NextResponse.json({ ok: true });
}
