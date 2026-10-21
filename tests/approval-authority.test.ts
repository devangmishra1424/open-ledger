import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { AccountConfigError, parseAccounts } from "@/lib/auth/accounts";
import { approvalRefusal } from "@/lib/auth/authority";
import { USER_HEADER, USER_NAME_HEADER } from "@/lib/auth/headers";
import { createBill } from "@/lib/bills";
import { writeDecision } from "@/lib/ledger/decisions";
import { POST as approve } from "@/app/api/invoices/[id]/approve/route";

/** Who may approve what, when people sign in: role, approval limit per currency, and never your own entry. */

const HASH = "scrypt$16384$8$1$c2FsdA$a2V5"; // format only: these tests never log in
const users = JSON.stringify([
  { username: "asha", name: "Asha Clerk", passwordHash: HASH, role: "clerk" },
  { username: "priya", name: "Priya Shah", passwordHash: HASH, approvalLimits: { INR: 500000, USD: 10000 } },
  { username: "ravi", name: "Ravi Admin", passwordHash: HASH, role: "admin" },
]);
afterEach(() => vi.unstubAllEnvs());

describe("approvalRefusal (pure)", () => {
  const [asha, priya, ravi] = parseAccounts(users);
  it("existing accounts without a role are approvers with no limit", () => {
    expect(parseAccounts(JSON.stringify([{ username: "old", name: "Old User", passwordHash: HASH }]))[0]).toMatchObject({ role: "approver", approvalLimits: {} });
  });
  it("a clerk never approves; an approver within their limit does; above it, not", () => {
    expect(approvalRefusal(asha, { amount: 10, currency: "INR", enteredBy: null })).toMatch(/is a clerk/);
    expect(approvalRefusal(priya, { amount: 400000, currency: "INR", enteredBy: "Asha Clerk" })).toBeNull();
    expect(approvalRefusal(priya, { amount: 600000, currency: "INR", enteredBy: null })).toMatch(/over Priya Shah's approval limit of INR 500000\.00/);
    expect(approvalRefusal(priya, { amount: 600000, currency: "EUR", enteredBy: null })).toBeNull(); // no EUR limit set
  });
  it("nobody approves an invoice they entered, not even an admin (segregation of duties)", () => {
    expect(approvalRefusal(ravi, { amount: 9e9, currency: "INR", enteredBy: "ravi admin " })).toMatch(/entered this invoice, so a different person must approve it/);
    expect(approvalRefusal(ravi, { amount: 9e9, currency: "INR", enteredBy: "Asha Clerk" })).toBeNull();
  });
  it("a bad role or limit in the settings is refused, not guessed at", () => {
    expect(() => parseAccounts(JSON.stringify([{ username: "x1", name: "X", passwordHash: HASH, role: "boss" }]))).toThrow(AccountConfigError);
    expect(() => parseAccounts(JSON.stringify([{ username: "x1", name: "X", passwordHash: HASH, approvalLimits: { inr: 5 } }]))).toThrow(AccountConfigError);
  });
});

describe("the Approve route, signed in", () => {
  const sql = getSql();
  const TAG = `AA-${randomUUID().slice(0, 6)}`;
  async function held(amount: number, enteredBy: string) {
    const b = await createBill({ vendorName: `${TAG} Vendor`, invoiceNumber: `${TAG}-${randomUUID().slice(0, 4)}`, currency: "INR", strictTotals: true, lines: [{ description: "Service", quantity: 1, unitPrice: amount }] });
    const now = new Date().toISOString();
    await writeDecision({ invoiceId: b.billId, nodeId: "extract", agentId: `human:${enteredBy}`, triggeredByActor: enteredBy, startedAt: now, actionTaken: "extracted", idempotencyKey: `${TAG}-x-${b.billId}` });
    await writeDecision({ invoiceId: b.billId, nodeId: "policy", agentId: "deterministic-policy-engine", startedAt: now, actionTaken: "escalate_l1", reasonCode: "EXC-NON_PO", idempotencyKey: `${TAG}-p-${b.billId}` });
    await sql`UPDATE vendor_bills SET status = 'exception' WHERE id = ${b.billId}`;
    return b.billId;
  }
  const as = (username: string, name: string, id: string) => approve(
    new Request("http://t/x", { method: "POST", headers: { "content-type": "application/json", [USER_HEADER]: username, [USER_NAME_HEADER]: encodeURIComponent(name) }, body: "{}" }),
    { params: Promise.resolve({ id }) });

  it("refuses with the reason, leaves the invoice waiting, and lets the right person approve", async () => {
    vi.stubEnv("VERIBOOK_USERS", users);
    const big = await held(600000, "Asha Clerk");
    const refused = await as("priya", "Priya Shah", big);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/over Priya Shah's approval limit/);
    expect((await sql`SELECT status FROM vendor_bills WHERE id = ${big}`)[0].status).toBe("exception");
    expect((await as("ravi", "Ravi Admin", big)).status).toBe(200);

    const own = await held(1000, "Priya Shah");
    expect((await as("priya", "Priya Shah", own)).status).toBe(403);
    expect((await as("asha", "Asha Clerk", own)).status).toBe(403);
  });
});
