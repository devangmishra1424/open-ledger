import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * db/client.ts must be importable with no DATABASE_URL: `next build` imports every route module, and a
 * hosted build (Vercel's, CI's) has no database secret. That was why every Vercel build failed. The
 * missing secret must still fail loud, at the first query instead of at import.
 */
describe("db/client without DATABASE_URL", () => {
  const saved = process.env.DATABASE_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    vi.resetModules();
  });

  it("imports without the secret and fails loud at first use", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    const client = await import("@/db/client");
    expect(() => client.getSql()).toThrow(/DATABASE_URL is not set/);
  });

  it("treats an empty DATABASE_URL as missing", async () => {
    process.env.DATABASE_URL = "";
    vi.resetModules();
    const client = await import("@/db/client");
    expect(() => client.getSql()).toThrow(/DATABASE_URL is not set/);
  });
});
