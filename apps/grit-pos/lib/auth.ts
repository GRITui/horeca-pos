import "server-only";

import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { prisma } from "@/lib/prisma";
import type { UserRole } from "@/app/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Session-based staff authentication, tenant-scoped.
//
// Sessions are a signed, httpOnly JWT (HS256) cookie containing just enough
// to scope every subsequent query: userId + tenantId + role, plus a normal
// JWT expiry. The cookie is opaque to the browser and can't be read or
// tampered with client-side.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "horeca_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and fill in a random secret (e.g. `openssl rand -base64 32`).",
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload extends JWTPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message = "Unauthorized", status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// -- Password hashing --------------------------------------------------------

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

// -- Session issuing / reading -----------------------------------------------

type SessionUser = {
  id: string;
  tenantId: string;
  role: UserRole;
  email: string;
};

/**
 * Signs a session JWT for the given user and sets it as an httpOnly cookie
 * on the current response. Must be called from a Route Handler or Server
 * Function (anywhere `cookies().set` is allowed).
 */
export async function createSession(user: SessionUser): Promise<void> {
  const token = await new SignJWT({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
  } satisfies Omit<SessionPayload, keyof JWTPayload>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clears the session cookie (logout). */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Reads and verifies the session cookie for the current request. Returns
 * `null` if there is no cookie, or it's missing/expired/invalid — never
 * throws, so callers can decide how to react.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    if (
      typeof payload.userId !== "string" ||
      typeof payload.tenantId !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.email !== "string"
    ) {
      return null;
    }
    return payload as SessionPayload;
  } catch {
    // Expired, bad signature, malformed — all treated as "not logged in".
    return null;
  }
}

/**
 * Loads the full, fresh User row for the current session (in case the
 * cached role/email in the JWT has since changed). Returns `null` if there
 * is no valid session or the user no longer exists.
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
  });
  if (!user || user.tenantId !== session.tenantId) return null;

  return user;
}

/**
 * Guard for use at the top of a Route Handler or Server Component: returns
 * the verified session, or throws `AuthError` (401) if the caller isn't
 * authenticated. Route handlers should catch `AuthError` and translate it
 * into a JSON 401 response.
 */
export async function requireAuth(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    throw new AuthError("Not authenticated");
  }
  return session;
}
