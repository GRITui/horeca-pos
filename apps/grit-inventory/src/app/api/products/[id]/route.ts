import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { hasRole } from "@/lib/auth";

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;
  const product = await db.product.findFirst({
    where: { id, tenantId: session.tenantId },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
  if (!product) return apiError("Product not found", 404);
  return NextResponse.json({ product });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateProductSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }

  const existing = await db.product.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Product not found", 404);

  const product = await db.product.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ product });
}

/** Soft delete: products stay for audit/order history, just hidden from active views. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  if (!hasRole(session.role, "ADMIN")) return apiError("Forbidden", 403);
  const { id } = await params;

  const existing = await db.product.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!existing) return apiError("Product not found", 404);

  await db.$transaction([
    db.product.update({ where: { id }, data: { isActive: false } }),
    db.variant.updateMany({ where: { productId: id }, data: { isActive: false } }),
  ]);

  return NextResponse.json({ ok: true });
}
