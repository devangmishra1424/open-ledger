import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authConfig } from "@/lib/auth/config";
import { bearerToken, verifySession } from "@/lib/auth/token";
import { PUBLIC_API_PATHS, USER_HEADER, USER_NAME_HEADER } from "@/lib/auth/headers";

/**
 * Runs in front of every /api/* route. Two jobs:
 *
 * 1. CORS. The frontend can be deployed to a different origin than this backend, and Next.js adds
 *    no CORS headers by itself. `*` is safe here because sign-in uses a bearer token in the
 *    Authorization header, not cookies: another site cannot make a browser send that token.
 *
 * 2. Sign-in (lib/auth/config.ts decides whether it is on). A valid session token is turned into
 *    two request headers the routes trust (who is acting); without one, a protected route answers
 *    401. The same headers are always deleted from the incoming request first, so a caller cannot
 *    claim to be someone by sending them. A server that is meant to require sign-in but is not
 *    configured answers 503 with the reason rather than serving an open API.
 */
export async function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCorsHeaders(new NextResponse(null, { status: 204 }));
  }

  const headers = new Headers(request.headers);
  headers.delete(USER_HEADER);
  headers.delete(USER_NAME_HEADER);

  // Literal process.env references: the Edge runtime is only guaranteed to see variables named this way.
  const config = authConfig({
    VERIBOOK_USERS: process.env.VERIBOOK_USERS,
    VERIBOOK_AUTH_SECRET: process.env.VERIBOOK_AUTH_SECRET,
    VERIBOOK_AUTH: process.env.VERIBOOK_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  });
  const isPublic = PUBLIC_API_PATHS.has(request.nextUrl.pathname);

  if (config.problem && !isPublic) {
    return withCorsHeaders(NextResponse.json({ error: config.problem }, { status: 503 }));
  }
  if (config.secret) {
    const session = await verifySession(bearerToken(request.headers.get("authorization")), config.secret);
    if (session) {
      headers.set(USER_HEADER, session.username);
      // Header values must be ASCII; a display name may not be.
      headers.set(USER_NAME_HEADER, encodeURIComponent(session.name));
    } else if (config.required && !isPublic) {
      return withCorsHeaders(NextResponse.json({ error: "Please sign in." }, { status: 401 }));
    }
  }
  return withCorsHeaders(NextResponse.next({ request: { headers } }));
}

function withCorsHeaders(response: NextResponse): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
