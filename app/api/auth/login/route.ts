import { handle, HttpError, readJsonBody, requireString } from "@/lib/http";
import { authConfig } from "@/lib/auth/config";
import { AccountConfigError, authenticate, parseAccounts } from "@/lib/auth/accounts";
import { signSession } from "@/lib/auth/token";
import { clientAddress, recordFailure, recordSuccess, retryAfterSeconds } from "@/lib/auth/login-throttle";

export const runtime = "nodejs";

/**
 * POST /api/auth/login  { username, password }  ->  { token, user: { username, name }, expiresAt }
 *
 * The token goes in `Authorization: Bearer <token>` on every later request (see middleware.ts).
 * One wording for every wrong combination, so the answer never says which usernames exist.
 */
export const POST = handle("POST /api/auth/login", async (req) => {
  const config = authConfig();
  if (config.problem) throw new HttpError(503, config.problem);
  if (!config.required || !config.secret) throw new HttpError(400, "Sign-in is not switched on for this server.");

  const address = clientAddress(req);
  const wait = retryAfterSeconds(address);
  if (wait > 0) {
    return Response.json({ error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  const body = await readJsonBody(req);
  const username = requireString(body, "username", { max: 100 });
  const password = requireString(body, "password", { max: 200 });

  let accounts;
  try {
    accounts = parseAccounts(process.env.VERIBOOK_USERS);
  } catch (e) {
    // A broken account list is the operator's problem, said plainly; it must not look like a wrong password.
    if (e instanceof AccountConfigError) throw new HttpError(503, `Sign-in is misconfigured: ${e.message}`);
    throw e;
  }

  const account = await authenticate(accounts, username, password);
  if (!account) {
    recordFailure(address);
    console.warn(`sign-in failed for username '${username.slice(0, 40)}' from ${address}`);
    throw new HttpError(401, "Wrong username or password.");
  }
  recordSuccess(address);
  const { token, exp } = await signSession({ username: account.username, name: account.name }, config.secret);
  console.info(`sign-in: ${account.username} from ${address}`);
  return Response.json({ token, user: { username: account.username, name: account.name }, expiresAt: exp });
});
