import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CORS for every /api/* route. Needed the moment the frontend is deployed to a different
 * origin than this backend (they're two separate Vercel projects) — without this, every fetch
 * from the deployed frontend gets blocked by the browser before it even reaches a route
 * handler, since Next.js doesn't add these headers on its own and this app has no per-route
 * OPTIONS handlers. Wide open (`*`) is a deliberate, reasonable choice here: this is a public
 * hackathon demo with no login/session cookies to protect — there's nothing an allowed origin
 * could steal by calling these endpoints that a direct visitor couldn't already do themselves.
 */
export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCorsHeaders(new NextResponse(null, { status: 204 }));
  }
  return withCorsHeaders(NextResponse.next());
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
