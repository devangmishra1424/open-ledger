import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { signSession, verifySession, bearerToken } from "@/lib/auth/token";
import { hashPassword, verifyPassword, parseAccounts, authenticate, AccountConfigError } from "@/lib/auth/accounts";
import { authConfig } from "@/lib/auth/config";
import { resetLoginThrottle } from "@/lib/auth/login-throttle";
import { reviewerName, sessionUser, HttpError } from "@/lib/http";
import { middleware } from "@/middleware";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as session } from "@/app/api/auth/session/route";

/** Pure sign-in logic plus the middleware and the two auth routes, called directly. No database. */

const SECRET = "test-secret-that-is-at-least-32-characters-long";
let priyaHash: string, samHash: string;

beforeAll(async () => {
  priyaHash = await hashPassword("priya-password-1");
  samHash = await hashPassword("sam-password-22");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLoginThrottle();
});

function usersJson() {
  return JSON.stringify([
    { username: "priya", name: "Priya Shah", passwordHash: priyaHash },
    { username: "sam", name: "Sam Lee", passwordHash: samHash },
  ]);
}

function signInOn() {
  vi.stubEnv("VERIBOOK_USERS", usersJson());
  vi.stubEnv("VERIBOOK_AUTH_SECRET", SECRET);
}

describe("session tokens", () => {
  it("a token verifies with the same secret and carries the account", async () => {
    const { token, exp } = await signSession({ username: "priya", name: "Priya Shah" }, SECRET, { nowSeconds: 1000, ttlSeconds: 60 });
    expect(await verifySession(token, SECRET, 1030)).toEqual({ username: "priya", name: "Priya Shah", exp });
  });
  it("is rejected when expired, signed with another secret, tampered with, or malformed", async () => {
    const { token } = await signSession({ username: "priya", name: "Priya Shah" }, SECRET, { nowSeconds: 1000, ttlSeconds: 60 });
    expect(await verifySession(token, SECRET, 1060)).toBeNull(); // expiry is exclusive
    expect(await verifySession(token, SECRET + "x", 1030)).toBeNull();
    const [v, payload, sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ u: "sam", n: "Sam Lee", exp: 9e9 })).toString("base64url");
    expect(await verifySession(`${v}.${forgedPayload}.${sig}`, SECRET, 1030)).toBeNull();
    expect(await verifySession(`${v}.${payload}`, SECRET, 1030)).toBeNull();
    expect(await verifySession("v2." + payload + "." + sig, SECRET, 1030)).toBeNull();
    expect(await verifySession("not a token", SECRET)).toBeNull();
    expect(await verifySession(undefined, SECRET)).toBeNull();
  });
  it("reads only a Bearer authorization header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer   xyz")).toBe("xyz");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("passwords and accounts", () => {
  it("a hash verifies only the password it was made from, and a malformed hash is a configuration error", async () => {
    expect(await verifyPassword("priya-password-1", priyaHash)).toBe(true);
    expect(await verifyPassword("priya-password-2", priyaHash)).toBe(false);
    await expect(verifyPassword("x", "sha256$abc")).rejects.toBeInstanceOf(AccountConfigError);
  });
  it("refuses short passwords when hashing", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 8/);
  });
  it("parses a valid account list and rejects every invalid shape with a reason", () => {
    expect(parseAccounts(usersJson()).map((a) => a.name)).toEqual(["Priya Shah", "Sam Lee"]);
    expect(parseAccounts(undefined)).toEqual([]);
    expect(() => parseAccounts("{")).toThrow(/not valid JSON/);
    expect(() => parseAccounts("[]")).toThrow(/non-empty/);
    expect(() => parseAccounts(JSON.stringify([{ username: "a b", name: "X", passwordHash: priyaHash }]))).toThrow(/username/);
    expect(() => parseAccounts(JSON.stringify([{ username: "ab", name: "X", passwordHash: "plain" }]))).toThrow(/auth:hash/);
    expect(() => parseAccounts(JSON.stringify([
      { username: "priya", name: "Priya Shah", passwordHash: priyaHash },
      { username: "priya2", name: "priya  shah", passwordHash: samHash },
    ]))).toThrow(/appears twice/); // names compare the way the maker/checker rule compares them
  });
  it("authenticates by username (any case) and password; an unknown user is simply null", async () => {
    const accounts = parseAccounts(usersJson());
    expect((await authenticate(accounts, "PRIYA", "priya-password-1"))?.name).toBe("Priya Shah");
    expect(await authenticate(accounts, "priya", "sam-password-22")).toBeNull();
    expect(await authenticate(accounts, "nobody", "priya-password-1")).toBeNull();
  });
});

describe("authConfig", () => {
  it("is on, with a secret, when accounts and a long enough secret are set", () => {
    expect(authConfig({ VERIBOOK_USERS: "[...]", VERIBOOK_AUTH_SECRET: SECRET })).toEqual({ required: true, secret: SECRET, problem: null });
  });
  it("refuses to run half-configured: accounts without a usable secret", () => {
    const c = authConfig({ VERIBOOK_USERS: "[...]", VERIBOOK_AUTH_SECRET: "short" });
    expect(c.required).toBe(true);
    expect(c.problem).toMatch(/VERIBOOK_AUTH_SECRET/);
  });
  it("is open with no accounts configured, in development and in production alike (an open proof of concept)", () => {
    expect(authConfig({ NODE_ENV: "development" })).toEqual({ required: false, secret: null, problem: null });
    expect(authConfig({ NODE_ENV: "production" })).toEqual({ required: false, secret: null, problem: null });
    expect(authConfig({ NODE_ENV: "production", VERIBOOK_AUTH: "off" })).toEqual({ required: false, secret: null, problem: null });
  });
  it("VERIBOOK_AUTH=off keeps it open even when accounts are listed", () => {
    expect(authConfig({ VERIBOOK_USERS: "[...]", VERIBOOK_AUTH_SECRET: SECRET, VERIBOOK_AUTH: "off" }).required).toBe(false);
  });
});

const api = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${path}`, { method: init.method ?? "GET", headers: init.headers });
const forwardedUser = (res: Response) => res.headers.get("x-middleware-request-x-veribook-user");

describe("middleware (the sign-in gate in front of every /api route)", () => {
  it("with sign-in off in development, passes requests through but strips identity headers a caller tries to send", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await middleware(api("/api/invoices", { headers: { "x-veribook-user": "priya", "x-veribook-user-name": "Priya%20Shah" } }));
    expect(res.status).toBe(200);
    expect(forwardedUser(res)).toBeNull();
    expect(res.headers.get("x-middleware-request-x-veribook-user-name")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("with sign-in on, a protected route without a valid token is 401, and a valid token is forwarded as the account", async () => {
    signInOn();
    expect((await middleware(api("/api/invoices"))).status).toBe(401);
    expect((await middleware(api("/api/invoices", { headers: { authorization: "Bearer v1.bad.token" } }))).status).toBe(401);
    // A forged identity header without a token is still refused.
    expect((await middleware(api("/api/invoices", { headers: { "x-veribook-user": "sam" } }))).status).toBe(401);

    const { token } = await signSession({ username: "sam", name: "Sam Lee" }, SECRET);
    const ok = await middleware(api("/api/invoices", { headers: { authorization: `Bearer ${token}`, "x-veribook-user": "priya" } }));
    expect(ok.status).toBe(200);
    expect(forwardedUser(ok)).toBe("sam"); // the token wins over anything the caller claimed
    expect(decodeURIComponent(ok.headers.get("x-middleware-request-x-veribook-user-name")!)).toBe("Sam Lee");
  });
  it("lets the sign-in routes and CORS preflights through without a token", async () => {
    signInOn();
    expect((await middleware(api("/api/auth/login", { method: "POST" }))).status).toBe(200);
    expect((await middleware(api("/api/auth/session"))).status).toBe(200);
    expect((await middleware(api("/api/invoices", { method: "OPTIONS" }))).status).toBe(204);
  });
  it("in production with no accounts configured, runs open, and still strips identity headers a caller tries to send", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERIBOOK_USERS", "");
    const res = await middleware(api("/api/invoices", { headers: { "x-veribook-user": "priya", "x-veribook-user-name": "Priya%20Shah" } }));
    expect(res.status).toBe(200);
    expect(forwardedUser(res)).toBeNull();
  });
  it("half-configured sign-in (accounts without a usable secret) refuses protected routes with the reason (503)", async () => {
    vi.stubEnv("VERIBOOK_USERS", '[{"username":"a","name":"A","passwordHash":"x"}]');
    vi.stubEnv("VERIBOOK_AUTH_SECRET", "short");
    const res = await middleware(api("/api/invoices"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/VERIBOOK_AUTH_SECRET/);
  });
});

const loginReq = (body: unknown, ip = "203.0.113.7") =>
  new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("POST /api/auth/login", () => {
  it("signs in with the right password and returns a token the middleware accepts", async () => {
    signInOn();
    const res = await login(loginReq({ username: "Priya", password: "priya-password-1" }), undefined as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ username: "priya", name: "Priya Shah" });
    expect((await verifySession(body.token, SECRET))?.name).toBe("Priya Shah");
  });
  it("gives the same answer for a wrong password and an unknown user, and never echoes the password", async () => {
    signInOn();
    const wrong = await login(loginReq({ username: "priya", password: "nope-nope-nope" }), undefined as never);
    const unknown = await login(loginReq({ username: "mallory", password: "nope-nope-nope" }), undefined as never);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });
  it("slows guessing: after 10 failures from one address, 429 even for the right password; other addresses are unaffected", async () => {
    signInOn();
    for (let i = 0; i < 10; i++) await login(loginReq({ username: "priya", password: `guess-${i}-xx` }, "198.51.100.1"), undefined as never);
    const blocked = await login(loginReq({ username: "priya", password: "priya-password-1" }, "198.51.100.1"), undefined as never);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(loginReq({ username: "priya", password: "priya-password-1" }, "198.51.100.2"), undefined as never)).status).toBe(200);
  }, 30_000);
  it("says plainly when sign-in is off, or when the account list is broken (not as a wrong password)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await login(loginReq({ username: "priya", password: "priya-password-1" }), undefined as never)).status).toBe(400);
    vi.stubEnv("VERIBOOK_USERS", "[not json");
    vi.stubEnv("VERIBOOK_AUTH_SECRET", SECRET);
    const broken = await login(loginReq({ username: "priya", password: "priya-password-1" }), undefined as never);
    expect(broken.status).toBe(503);
    expect((await broken.json()).error).toMatch(/misconfigured/);
  });
});

describe("who is acting (reviewerName)", () => {
  const withSession = (name: string) => new Request("http://localhost/x", { headers: { "x-veribook-user": "u", "x-veribook-user-name": encodeURIComponent(name) } });

  it("with a session, is the account's name, whatever name the body claims", () => {
    expect(reviewerName({ reviewerName: "Someone Else" }, withSession("Priya Shāh"))).toBe("Priya Shāh");
    expect(sessionUser(withSession("Sam Lee"))).toEqual({ username: "u", name: "Sam Lee" });
  });
  it("with sign-in off, is the typed name, still required", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(reviewerName({ reviewerName: " Priya " })).toBe("Priya");
    expect(() => reviewerName({})).toThrow(HttpError);
  });
  it("with sign-in on but no session on the request, is a 401 rather than trusting the body", () => {
    signInOn();
    expect(() => reviewerName({ reviewerName: "Priya Shah" }, new Request("http://localhost/x"))).toThrow(/sign in/);
  });
  it("GET /api/auth/session reports the mode and the account behind the request", async () => {
    signInOn();
    const body = await (await session(withSession("Sam Lee"), undefined as never)).json();
    expect(body).toEqual({ required: true, configured: true, problem: null, user: { username: "u", name: "Sam Lee" } });
  });
});
