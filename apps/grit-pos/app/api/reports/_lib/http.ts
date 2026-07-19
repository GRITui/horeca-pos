import "server-only";

import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Small shared error type + response mapper for the reports API routes.
// Mirrors app/api/orders/_lib/http.ts and app/api/reconciliation/_lib/http.ts
// — kept as its own local copy so each top-level API feature stays
// self-contained, same pattern as those two.
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
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
