import { NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createSession, hashPassword } from "@/lib/auth";
import { rateLimit } from "@/lib/rateLimit";

// Bootstraps a brand-new restaurant account: creates the Tenant and its
// first (owner) User together, in one transaction, then logs that user in.

interface RegisterBody {
  tenantName?: string;
  slug?: string;
  email?: string;
  password?: string;
}

// Unauthenticated, DB-writing endpoint — rate limit it so it can't be used
// to spam-create tenants/accounts.
export async function POST(request: Request) {
  const limitResult = rateLimit(request, { limit: 5, windowMs: 60_000 });
  if (!limitResult.success) {
    return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429 });
  }

  let body: RegisterBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { tenantName, slug, email, password } = body;

  if (!tenantName || !slug || !email || !password) {
    return NextResponse.json(
      { error: "tenantName, slug, email, and password are all required" },
      { status: 400 },
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 },
    );
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json(
      { error: "slug must be lowercase letters, numbers, and hyphens only" },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(password);

  try {
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: tenantName, slug },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: email.toLowerCase(),
          passwordHash,
          role: "owner",
        },
      });
      return { tenant, user };
    });

    await createSession({
      id: user.id,
      tenantId: tenant.id,
      role: user.role,
      email: user.email,
    });

    return NextResponse.json(
      {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        user: { id: user.id, email: user.email, role: user.role },
      },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "That tenant slug is already taken" },
        { status: 409 },
      );
    }
    throw error;
  }
}
