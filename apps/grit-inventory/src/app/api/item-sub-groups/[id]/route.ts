import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const updateSubGroupSchema = z.object({
  name: z.string().min(1).optional(),
  direction: z.enum(["up", "down"]).optional(),
});

/** PATCH /api/item-sub-groups/[id] — rename and/or reorder (swap sortOrder
 * with the previous/next sibling within the same parent group). */
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
  const subGroup = await db.itemSubGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!subGroup) return apiError("Sub-group not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = updateSubGroupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const { name, direction } = parsed.data;
  if (!name && !direction) return apiError("Nothing to update");

  try {
    await db.$transaction(async (tx) => {
      if (name) {
        await tx.itemSubGroup.update({ where: { id: subGroup.id }, data: { name } });
      }
      if (direction) {
        const siblings = await tx.itemSubGroup.findMany({
          where: { groupId: subGroup.groupId },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, sortOrder: true },
        });
        const idx = siblings.findIndex((s) => s.id === subGroup.id);
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return;
        const current = siblings[idx];
        const swapWith = siblings[swapIdx];
        await tx.itemSubGroup.update({
          where: { id: current.id },
          data: { sortOrder: swapWith.sortOrder },
        });
        await tx.itemSubGroup.update({
          where: { id: swapWith.id },
          data: { sortOrder: current.sortOrder },
        });
      }
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A sub-group with that name already exists in this group", 409);
    }
    throw err;
  }

  const updated = await db.itemSubGroup.findUniqueOrThrow({ where: { id: subGroup.id } });
  return NextResponse.json({ subGroup: updated });
}

/** DELETE /api/item-sub-groups/[id] — refuses (409) while any product still
 * references this sub-group; unassign those first (via the products
 * sub-resource). */
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
  const subGroup = await db.itemSubGroup.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!subGroup) return apiError("Sub-group not found", 404);

  const productCount = await db.product.count({ where: { subGroupId: subGroup.id } });
  if (productCount > 0) {
    return apiError("Sub-group still has products assigned — remove them first", 409);
  }

  await db.itemSubGroup.delete({ where: { id: subGroup.id } });
  return NextResponse.json({ ok: true });
}
