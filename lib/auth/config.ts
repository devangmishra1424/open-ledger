/**
 * Whether sign-in is on, and whether it is configured well enough to trust. Reads only
 * environment variables (no Node APIs), so the Edge middleware can use it too.
 *
 *   VERIBOOK_USERS        JSON list of accounts (see lib/auth/accounts.ts); turns sign-in on
 *   VERIBOOK_AUTH_SECRET  at least 32 characters; signs session tokens
 *   VERIBOOK_AUTH=off     run with no sign-in at all, on purpose (a local demo only)
 *
 * Secure by default: a production server (NODE_ENV=production) with no accounts configured does
 * not quietly serve an open API. It answers 503 with the reason, so a missing env var on a host is
 * visible on the first request instead of leaving invoices approvable by anyone.
 */

export const MIN_SECRET_LENGTH = 32;

export interface AuthConfig {
  /** Requests must carry a valid session. */
  required: boolean;
  /** Signing secret, when sign-in is on and configured. */
  secret: string | null;
  /** Set when the server must refuse requests rather than run unprotected or half-configured. */
  problem: string | null;
}

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const usersSet = Boolean(env.VERIBOOK_USERS && env.VERIBOOK_USERS.trim());
  const secret = env.VERIBOOK_AUTH_SECRET?.trim() || "";
  const explicitlyOff = env.VERIBOOK_AUTH?.trim().toLowerCase() === "off";

  if (usersSet) {
    if (secret.length < MIN_SECRET_LENGTH) {
      return { required: true, secret: null, problem: `Sign-in is switched on (VERIBOOK_USERS) but VERIBOOK_AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.` };
    }
    return { required: true, secret, problem: null };
  }
  if (explicitlyOff) return { required: false, secret: null, problem: null };
  if (env.NODE_ENV === "production") {
    return { required: true, secret: null, problem: "Sign-in is not configured on this server: set VERIBOOK_USERS and VERIBOOK_AUTH_SECRET (or VERIBOOK_AUTH=off for a deliberately open local demo)." };
  }
  // Local development with nothing configured: open, exactly as before sign-in existed.
  return { required: false, secret: null, problem: null };
}
