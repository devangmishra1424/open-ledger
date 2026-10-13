/**
 * Whether sign-in is on, and whether it is configured well enough to trust. Reads only
 * environment variables (no Node APIs), so the Edge middleware can use it too.
 *
 *   VERIBOOK_USERS        JSON list of accounts (see lib/auth/accounts.ts); turns sign-in on
 *   VERIBOOK_AUTH_SECRET  at least 32 characters; signs session tokens
 *   VERIBOOK_AUTH=off     no sign-in even if accounts are listed
 *
 * Off unless accounts are configured, in production too. VeriBook is run as an open proof of
 * concept: anyone with the link uses the workbench and reviewer names are self-declared, exactly as
 * before sign-in existed. Sign-in is opt-in: set VERIBOOK_USERS and a secret to turn it on. A
 * half-configured sign-in (accounts without a usable secret) still refuses requests with the
 * reason, rather than running with accounts nobody can sign in to.
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

  if (usersSet && !explicitlyOff) {
    if (secret.length < MIN_SECRET_LENGTH) {
      return { required: true, secret: null, problem: `Sign-in is switched on (VERIBOOK_USERS) but VERIBOOK_AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.` };
    }
    return { required: true, secret, problem: null };
  }
  // No accounts configured (or VERIBOOK_AUTH=off): open, in development and production alike.
  return { required: false, secret: null, problem: null };
}
