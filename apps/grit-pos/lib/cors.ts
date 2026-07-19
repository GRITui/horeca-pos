// CORS helper for public, unauthenticated endpoints (QR dine-in / pickup
// links) that may be fetched from a different origin than the app itself
// (e.g. a customer's phone browser hitting an embedded webview, or a
// separate storefront origin).

export interface CorsOptions {
  /** Allowed origin(s). Defaults to "*" (fine for anonymous, read-mostly public endpoints). */
  origin?: string;
  methods?: string[];
  headers?: string[];
}

const DEFAULT_OPTIONS: Required<CorsOptions> = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  headers: ["Content-Type"],
};

function buildCorsHeaders(options?: CorsOptions): Headers {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", opts.origin);
  headers.set("Access-Control-Allow-Methods", opts.methods.join(", "));
  headers.set("Access-Control-Allow-Headers", opts.headers.join(", "));
  return headers;
}

/** Applies CORS headers to an existing Response (mutates and returns it). */
export function withCors(response: Response, options?: CorsOptions): Response {
  const corsHeaders = buildCorsHeaders(options);
  corsHeaders.forEach((value, key) => response.headers.set(key, value));
  return response;
}

/** Builds a 204 response for an `OPTIONS` preflight request. */
export function corsPreflightResponse(options?: CorsOptions): Response {
  return new Response(null, { status: 204, headers: buildCorsHeaders(options) });
}
