import { describe, it, expect } from "vitest";
import { getSql, activeSchema } from "@/db/client";
import { rollingPeriods } from "@/db/migrate-lib";

/**
 * The guard rail the rest of the suite stands on: DB-backed tests must run in their own schema
 * and must never be able to see the live `public` tables. If these fail, STOP — do not run the
 * rest of the suite, because db/migrate-lib.ts does unqualified DROPs.
 */
describe("test schema isolation", () => {
  it("workers are pinned to the test schema only (no public fallback)", async () => {
    expect(activeSchema()).toBe("veribook_test");
    const sql = getSql();
    const [{ search_path }] = await sql`SHOW search_path`;
    expect(search_path.replace(/"/g, "").trim()).toBe("veribook_test");
  });

  it("unqualified table names resolve inside the test schema, with reference data seeded", async () => {
    const sql = getSql();
    const [{ s }] = await sql`SELECT current_schema() AS s`;
    expect(s).toBe("veribook_test");
    const [{ owner }] = await sql`
      SELECT n.nspname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('decisions')`;
    expect(owner).toBe("veribook_test");
    const [{ accounts }] = await sql`SELECT count(*)::int AS accounts FROM chart_of_accounts`;
    expect(accounts).toBe(24); // 23 + 7300 Rounding and Discounts (migration 006)
  });
});

describe("rollingPeriods", () => {
  it("covers 3 months back to 3 months ahead, with correct month ends", () => {
    const p = rollingPeriods(new Date("2026-10-08T12:00:00Z"));
    expect(p.map((x) => x.id)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(p.find((x) => x.id === "2026-09")).toEqual({ id: "2026-09", start: "2026-09-01", end: "2026-09-30" });
    expect(p.find((x) => x.id === "2026-12")?.end).toBe("2026-12-31");
  });

  it("handles a leap-year February and the year boundary", () => {
    const p = rollingPeriods(new Date("2028-01-31T00:00:00Z"));
    expect(p.map((x) => x.id)).toEqual(["2027-10", "2027-11", "2027-12", "2028-01", "2028-02", "2028-03", "2028-04"]);
    expect(p.find((x) => x.id === "2028-02")?.end).toBe("2028-02-29");
  });
});
