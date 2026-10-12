import { authConfig } from "@/lib/auth/config";
import { USER_HEADER, USER_NAME_HEADER } from "@/lib/auth/headers";

/**
 * Small request/response helpers shared by the API routes, so every route validates its input
 * at the edge the same way and maps failures to the same JSON error shape: { error: string }.
 */

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Parses a JSON object body. An empty body is `{}`; malformed JSON or a non-object is a 400 (not silently treated as empty). */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string, opts: { max?: number } = {}): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `${key} is required`);
  const t = v.trim();
  if (t.length > (opts.max ?? 500)) throw new HttpError(400, `${key} is too long (max ${opts.max ?? 500} characters)`);
  return t;
}

export function optionalString(body: Record<string, unknown>, key: string, opts: { max?: number } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > (opts.max ?? 2000)) throw new HttpError(400, `${key} is too long (max ${opts.max ?? 2000} characters)`);
  return t || undefined;
}

/**
 * The signed-in account for this request, from the headers the middleware sets after checking the
 * session token (it deletes any a caller sent). Null when sign-in is off, or for a direct call that
 * did not go through the middleware (tests).
 */
export function sessionUser(req: Request | undefined): { username: string; name: string } | null {
  const username = req?.headers.get(USER_HEADER);
  const encodedName = req?.headers.get(USER_NAME_HEADER);
  if (!username || !encodedName) return null;
  try {
    return { username, name: decodeURIComponent(encodedName) };
  } catch {
    // Only the middleware writes this header, with encodeURIComponent; a value that does not decode is a bug, not a user.
    throw new HttpError(400, "malformed session header");
  }
}

/**
 * Who is acting. Required on every state-changing action: there is no "demo-reviewer" default,
 * because maker/checker is meaningless if two people can both be "demo-reviewer".
 *
 * With sign-in on, it is the signed-in account's name and any name in the body is ignored: the
 * audit trail and the "a different person must sign off" check then compare real accounts, not
 * typed names. With sign-in off (local development), it is the name the person typed.
 */
export function reviewerName(body: Record<string, unknown>, req?: Request): string {
  const user = sessionUser(req);
  if (user) return user.name;
  if (authConfig().required) throw new HttpError(401, "Please sign in.");
  return requireString(body, "reviewerName", { max: 80 });
}

/** Wraps a route handler: HttpError -> its status; anything unexpected -> logged with context and a generic 500. */
export function handle<C>(label: string, fn: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(`${label} failed:`, e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
