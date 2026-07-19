import "server-only";

import { NextResponse } from "next/server";
import { AuthError } from "@/lib/tenant";

// ---------------------------------------------------------------------------
// Small shared error type + response mapper for the orders API routes.
// Route handlers throw `HttpError` (or let `AuthError` from lib/tenant
// propagate) and call `errorResponse()` in a catch block to turn either into
// a consistent JSON error response.
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/** Parses the JSON body of a request, throwing a 400 HttpError on failure. */
export async function readJsonBody<T = unknown>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
