import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * VeriBook accounts, read from VERIBOOK_USERS: a JSON list such as
 *
 *   [{"username":"priya","name":"Priya Shah","passwordHash":"scrypt$16384$8$1$<salt>$<hash>"},
 *    {"username":"sam","name":"Sam Lee","passwordHash":"scrypt$16384$8$1$<salt>$<hash>"}]
 *
 * Passwords are never stored or configured in plain text: `npm run auth:hash -- <password>` prints
 * the hash to paste. Display names must be unique, because they are what the audit trail records
 * and what the "a different person must sign off" check compares.
 *
 * Node only (scrypt). The middleware never needs this: it only checks signed tokens.
 */

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const N = 16384, R = 8, P = 1, KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;

export type Role = "clerk" | "approver" | "admin";

export interface Account {
  username: string;
  name: string;
  passwordHash: string;
  /** clerk: enters and challenges, never approves. approver (the default): approves within its limits. admin: no amount limit. */
  role: Role;
  /** Largest invoice this person may approve, per currency ({"INR": 500000}); a currency not listed has no limit. */
  approvalLimits: Record<string, number>;
}

export class AccountConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountConfigError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** True when `password` matches `stored`. A malformed stored hash is a configuration error, not a wrong password. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new AccountConfigError("a passwordHash is not in the scrypt$N$r$p$salt$hash format (use npm run auth:hash)");
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || salt.length === 0 || expected.length === 0) {
    throw new AccountConfigError("a passwordHash has invalid scrypt parameters");
  }
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  return timingSafeEqual(actual, expected);
}

const USERNAME = /^[A-Za-z0-9._-]{2,40}$/;

/** Parses and validates VERIBOOK_USERS. Throws AccountConfigError with a readable reason; never returns a half-valid list. */
export function parseAccounts(raw: string | undefined): Account[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountConfigError("VERIBOOK_USERS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new AccountConfigError("VERIBOOK_USERS must be a non-empty JSON list");
  const accounts: Account[] = [];
  const usernames = new Set<string>(), names = new Set<string>();
  for (const [i, entry] of parsed.entries()) {
    const e = entry as Record<string, unknown>;
    const username = typeof e?.username === "string" ? e.username.trim() : "";
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    const passwordHash = typeof e?.passwordHash === "string" ? e.passwordHash.trim() : "";
    if (!USERNAME.test(username)) throw new AccountConfigError(`VERIBOOK_USERS[${i}]: username must be 2-40 letters, digits, '.', '_' or '-'`);
    if (!name || name.length > 80) throw new AccountConfigError(`VERIBOOK_USERS[${i}]: name is required (at most 80 characters)`);
    if (!passwordHash.startsWith("scrypt$")) throw new AccountConfigError(`VERIBOOK_USERS[${i}]: passwordHash must come from npm run auth:hash`);
    const userKey = username.toLowerCase();
    // Names are compared case- and space-insensitively by the maker/checker rule, so uniqueness is checked the same way.
    const nameKey = name.toLowerCase().replace(/\s+/g, " ");
    if (usernames.has(userKey)) throw new AccountConfigError(`VERIBOOK_USERS: username '${username}' appears twice`);
    if (names.has(nameKey)) throw new AccountConfigError(`VERIBOOK_USERS: name '${name}' appears twice; names must be unique because the audit trail records them`);
    const role = e.role === undefined ? "approver" : e.role;
    if (role !== "clerk" && role !== "approver" && role !== "admin") throw new AccountConfigError(`VERIBOOK_USERS[${i}]: role must be clerk, approver or admin`);
    const limits = e.approvalLimits ?? {};
    if (typeof limits !== "object" || Array.isArray(limits) || Object.entries(limits as object).some(([c, v]) => !/^[A-Z]{3}$/.test(c) || typeof v !== "number" || !(v >= 0))) {
      throw new AccountConfigError(`VERIBOOK_USERS[${i}]: approvalLimits must look like {"INR": 500000, "USD": 10000}`);
    }
    usernames.add(userKey);
    names.add(nameKey);
    accounts.push({ username, name, passwordHash, role, approvalLimits: limits as Record<string, number> });
  }
  return accounts;
}

let dummyHash: Promise<string> | null = null;

/**
 * The account for these credentials, or null. An unknown username still costs one scrypt run, so
 * response time does not reveal which usernames exist.
 */
export async function authenticate(accounts: Account[], username: string, password: string): Promise<Account | null> {
  const account = accounts.find((a) => a.username.toLowerCase() === username.trim().toLowerCase());
  if (!account) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, account.passwordHash)) ? account : null;
}
