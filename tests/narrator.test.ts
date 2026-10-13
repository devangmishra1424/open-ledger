import { describe, it, expect, beforeAll, vi } from "vitest";

// The AI call itself is replaced: this is about how many calls are made, in what order, and how a failure is reported.
let inFlight = 0;
let maxInFlight = 0;
const calls: string[] = [];
// The first two calls wait until a third has started, so the test sees three in flight at once if the
// narrator really runs them concurrently (a sequential narrator would never start the third: the test
// then fails on its timeout). Waiting on that condition, not on a clock.
let releaseFirstTwo: () => void = () => {};
const thirdStarted = new Promise<void>((resolve) => { releaseFirstTwo = resolve; });
vi.mock("@/lib/explain", () => ({
  explain: vi.fn(async (invoiceId: string) => {
    calls.push(invoiceId);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (calls.length < 3) await thirdStarted;
    else if (calls.length === 3) releaseFirstTwo();
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    if (invoiceId === failingId) throw new Error("The AI provider's daily usage limit was reached.");
    return { answer: `answer for ${invoiceId}`, citedDecisionIds: ["d"], grounded: true };
  }),
}));

import { getSql } from "@/db/client";
import { writeDecision } from "@/lib/ledger/decisions";
import { narratePbcResponse, MAX_INVOICES } from "@/lib/audit/narrator";

const sql = getSql();
const PREFIX = "TEST-NARRATOR";
const billIds: string[] = [];
let failingId = "";
let requestId = "";
let noDecisionId = "";

beforeAll(async () => {
  const vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name) VALUES (${vendorId}, ${PREFIX + " Vendor"})`;
  for (let i = 1; i <= 12; i++) {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, currency, subtotal, total_amount, status)
      VALUES (${id}, ${vendorId}, ${`${PREFIX}-${String(i).padStart(2, "0")}`}, '2026-09-01', 'USD', 10, 10, 'posted')`;
    if (i !== 4) {
      await writeDecision({ invoiceId: id, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: new Date().toISOString(), actionTaken: "auto_approve" });
    } else {
      noDecisionId = id;
    }
    billIds.push(id);
  }
  failingId = billIds[2];
  requestId = crypto.randomUUID();
  await sql`INSERT INTO pbc_requests (id, item_type, description, status, linked_invoice_ids) VALUES (${requestId}, 'invoice_bundle', ${PREFIX}, 'open', ${billIds.join(",")})`;
});

describe("answering an auditor's question across a request's invoices", () => {
  it("asks about at most MAX_INVOICES, at most 3 at a time, keeps their order, and reports a failure on its own invoice", async () => {
    const out = await narratePbcResponse(requestId, "Why was this approved?");

    expect(out.totalLinked).toBe(12);
    expect(out.answeredFor).toBe(MAX_INVOICES);
    expect(out.results.map((r) => r.invoiceId)).toEqual(billIds.slice(0, MAX_INVOICES));
    expect(maxInFlight).toBe(3);
    expect(calls).not.toContain(billIds[10]);

    const failed = out.results[2];
    expect(failed).toMatchObject({ invoiceId: failingId, invoiceNumber: `${PREFIX}-03` });
    expect("error" in failed && failed.error).toMatch(/usage limit/);

    expect(out.results[3]).toMatchObject({ invoiceId: noDecisionId, skipped: expect.stringMatching(/No decisions/) });
    expect(out.results[0]).toMatchObject({ invoiceNumber: `${PREFIX}-01`, answer: `answer for ${billIds[0]}`, grounded: true });
  });
});
