/**
 * Signed session tokens for VeriBook sign-in.
 *
 * Format: `v1.<payload>.<signature>`, both parts base64url. The payload is JSON
 * `{ u: username, n: display name, exp: unix seconds }`; the signature is HMAC-SHA256 over
 * `v1.<payload>` with VERIBOOK_AUTH_SECRET. Stateless on purpose: nothing to store, and any
 * instance with the same secret can check a token. The cost is that a token cannot be revoked
 * before it expires (12 hours by default); rotating the secret signs everyone out.
 *
 * Uses only the Web Crypto API (crypto.subtle), so the same code runs in the Next.js middleware
 * (Edge runtime) and in route handlers (Node). Verification goes through crypto.subtle.verify,
 * which compares in constant time.
 */

export interface SessionUser {
  username: string;
  name: string;
}

export interface Session extends SessionUser {
  /** Expiry, unix seconds. */
  exp: number;
}

const VERSION = "v1";
export const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    // atob rejects malformed input; for a token that just means "not a valid token".
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Signs a session for `user`, valid for `ttlSeconds` from `nowSeconds`. */
export async function signSession(user: SessionUser, secret: string, opts: { ttlSeconds?: number; nowSeconds?: number } = {}): Promise<{ token: string; exp: number }> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlSeconds ?? DEFAULT_SESSION_SECONDS);
  const payload = base64url(encoder.encode(JSON.stringify({ u: user.username, n: user.name, exp })));
  const signed = `${VERSION}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(signed)));
  return { token: `${signed}.${base64url(signature)}`, exp };
}

/**
 * Returns the session if `token` is well formed, signed with `secret`, and not expired; otherwise
 * null. Never throws on bad input: a forged, truncated or expired token is simply "not signed in".
 */
export async function verifySession(token: string | null | undefined, secret: string, nowSeconds?: number): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payloadPart, signaturePart] = parts;
  const signature = fromBase64url(signaturePart);
  const payloadBytes = fromBase64url(payloadPart);
  if (!signature || !payloadBytes) return null;

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, encoder.encode(`${VERSION}.${payloadPart}`));
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    // A correctly signed but unparseable payload can only come from a bug in signSession; treat as invalid.
    return null;
  }
  const p = payload as { u?: unknown; n?: unknown; exp?: unknown };
  if (typeof p.u !== "string" || typeof p.n !== "string" || typeof p.exp !== "number") return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (p.exp <= now) return null;
  return { username: p.u, name: p.n, exp: p.exp };
}

/** Pulls the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return m ? m[1] : null;
}
