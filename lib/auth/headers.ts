/**
 * The request headers the middleware sets after checking a session token. Routes read who is
 * acting from these (lib/http.ts sessionUser), never from the request body. The middleware deletes
 * any copies a caller sends, so they cannot be forged from outside.
 */
export const USER_HEADER = "x-veribook-user";
/** URI-encoded display name (header values must be ASCII). */
export const USER_NAME_HEADER = "x-veribook-user-name";

/** API paths reachable without signing in: signing in itself, and asking whether sign-in is needed. */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(["/api/auth/login", "/api/auth/session"]);
