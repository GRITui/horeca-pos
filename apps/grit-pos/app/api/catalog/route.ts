import { NextResponse } from "next/server";
import { requireTenantId, AuthError } from "@/lib/tenant";
import { getCatalogForTenant, serializeCatalog } from "./_lib/catalog";

/** GET /api/catalog — tenant-scoped Category > Product > Variant/AddOn tree for the POS. */
export async function GET() {
  try {
    const tenantId = await requireTenantId();
    const categories = await getCatalogForTenant(tenantId);
    return NextResponse.json({ categories: serializeCatalog(categories) });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
