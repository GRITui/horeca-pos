import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const createGroupSchema = z.object({
  name: z.string().min(1),
});

/**
 * GET /api/item-groups — the tenant's item groups with their sub-groups
 * (each annotated with its assigned-product count, so the UI can disable
 * delete on non-empty sub-groups without a second round trip). SCALE only
 * (`inventory.multi_location`, the existing gate this pass reuses).
 */
export async function GET() {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
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
  return NextResponse.json({ groups });
}

/** POST /api/item-groups — create a new item group, appended to the end of
 * the tenant's sort order. */
export async function POST(request: NextRequest) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await request.json().catch(() => null);
  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid group");
  }

  const max = await db.itemGroup.aggregate({
    where: { tenantId: ctx.local.tenantId },
    _max: { sortOrder: true },
  });

  try {
    const group = await db.itemGroup.create({
      data: {
        tenantId: ctx.local.tenantId,
        name: parsed.data.name,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      include: { subGroups: true },
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return apiError("A group with that name already exists", 409);
    }
    throw err;
  }
}
