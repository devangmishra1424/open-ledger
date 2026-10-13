import { describe, it, expect, beforeAll } from "vitest";
import { getSql } from "@/db/client";
import { writeDecision } from "@/lib/ledger/decisions";
import { USER_HEADER, USER_NAME_HEADER } from "@/lib/auth/headers";
import { listFrontendEvidenceRecords, listFrontendPbcRequests } from "@/lib/pbc-shapes";
import * as requestsRoute from "@/app/api/pbc/requests/route";
import * as filesRoute from "@/app/api/pbc/requests/[id]/files/route";
import * as fileRoute from "@/app/api/pbc/requests/[id]/files/[fileId]/route";
import * as closeRoute from "@/app/api/pbc/requests/[id]/close/route";
import * as narrateRoute from "@/app/api/pbc/[id]/narrate/route";
import * as sealRoute from "@/app/api/invoices/[id]/seal/route";

/**
 * The audit feature through its real route handlers, against the real (test-schema) database. No LLM
 * call is made. Rows are left in place: the test schema is rebuilt before every run
 * (tests/global-setup.ts), and deleting chained decisions would cut the chain under later suites.
 */

const sql = getSql();
const PREFIX = "TEST-AUDIT-ROUTES";
let vendorId: string;
const bills: string[] = [];

function post(body: unknown, session?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) {
    headers[USER_HEADER] = session.toLowerCase().replace(/\s+/g, "-");
    headers[USER_NAME_HEADER] = encodeURIComponent(session);
  }
  return new Request("http://test/api", { method: "POST", headers, body: JSON.stringify(body) });
}
const get = () => new Request("http://test/api");
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function makeBillWithDecision(n: number): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, currency, subtotal, total_amount, status)
    VALUES (${id}, ${vendorId}, ${`${PREFIX}-INV-${n}`}, '2026-09-01', 'USD', 100, 100, 'posted')`;
  await writeDecision({
    invoiceId: id, nodeId: "policy", agentId: "deterministic-policy-engine",
    startedAt: new Date().toISOString(), actionTaken: "auto_approve", reasonCode: "CLEAN_MATCH",
  });
  bills.push(id);
  return id;
}

beforeAll(async () => {
  vendorId = crypto.randomUUID();
  await sql`INSERT INTO vendors (id, name) VALUES (${vendorId}, ${PREFIX + " Vendor"})`;
  await makeBillWithDecision(1);
  await makeBillWithDecision(2);
});

describe("recording an auditor request (POST /api/pbc/requests)", () => {
  it("refuses what it cannot fulfil or check: no description, an unsupported kind, an unknown invoice, a bad list", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ reviewerName: "Ana" }, /description is required/],
      [{ reviewerName: "Ana", description: "x", itemType: "ap_aging" }, /only kind of request/],
      [{ reviewerName: "Ana", description: "x", linkedInvoiceIds: ["no-such-invoice"] }, /unknown invoice id: no-such-invoice/],
      [{ reviewerName: "Ana", description: "x", linkedInvoiceIds: "not-a-list" }, /must be a list/],
      [{ reviewerName: "Ana", description: "x", dueDate: "next week" }, /dueDate/],
      [{ description: "x" }, /reviewerName is required/],
    ];
    for (const [body, message] of cases) {
      const res = await requestsRoute.POST(post(body), ctx({}));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
    }
  });

  it("records who created it (the signed-in account, not a typed name) and links real invoices", async () => {
    const res = await requestsRoute.POST(post({ description: `${PREFIX} sample`, reviewerName: "Typed Name", linkedInvoiceIds: bills }, "Priya Shah"), ctx({}));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const listed = (await listFrontendPbcRequests()).find((r) => r.request_id === id);
    expect(listed).toMatchObject({ created_by: "Priya Shah", linked_count: 2, status: "open", closed_by: null });
  });
});

describe("supporting files", () => {
  let requestId: string;
  beforeAll(async () => {
    requestId = (await (await requestsRoute.POST(post({ description: `${PREFIX} files`, reviewerName: "Ana" }), ctx({}))).json()).id;
  });

  it("regression: an attached file can be downloaded again, byte for byte, as a safe attachment", async () => {
    const bytes = Buffer.from("Bank confirmation: balance 12,500.00\n", "utf-8");
    const up = await filesRoute.POST(post({ filename: "C:\\scans\\confirmation.txt", contentBase64: bytes.toString("base64"), contentType: "text/plain" }, "Sam Lee"), ctx({ id: requestId }));
    expect(up.status).toBe(201);
    const uploaded = await up.json();
    expect(uploaded).toMatchObject({ filename: "confirmation.txt", sizeBytes: bytes.length, uploadedBy: "Sam Lee" });

    const [listed] = await (await filesRoute.GET(get(), ctx({ id: requestId }))).json();
    expect(listed).toMatchObject({ id: uploaded.id, uploadedBy: "Sam Lee", sizeBytes: bytes.length });

    const down = await fileRoute.GET(get(), ctx({ id: requestId, fileId: uploaded.id }));
    expect(down.status).toBe(200);
    expect(down.headers.get("content-type")).toBe("application/octet-stream");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    expect(down.headers.get("content-disposition")).toMatch(/^attachment; filename="confirmation.txt"/);
    expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("a file id from another request is not served", async () => {
    const other = (await (await requestsRoute.POST(post({ description: `${PREFIX} other`, reviewerName: "Ana" }), ctx({}))).json()).id;
    const up = await (await filesRoute.POST(post({ filename: "a.txt", contentBase64: "aGk=", reviewerName: "Ana" }), ctx({ id: requestId }))).json();
    expect((await fileRoute.GET(get(), ctx({ id: other, fileId: up.id }))).status).toBe(404);
  });

  it("refuses an oversized file (413), content that is not base64, and an unusable name", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    expect((await filesRoute.POST(post({ filename: "big.bin", contentBase64: big, reviewerName: "Ana" }), ctx({ id: requestId }))).status).toBe(413);
    expect((await filesRoute.POST(post({ filename: "x.txt", contentBase64: "not base64!", reviewerName: "Ana" }), ctx({ id: requestId }))).status).toBe(400);
    expect((await filesRoute.POST(post({ filename: "../", contentBase64: "aGk=", reviewerName: "Ana" }), ctx({ id: requestId }))).status).toBe(400);
  });
});

describe("closing a request hands the evidence over, on the record", () => {
  it("writes an evidence entry on each linked invoice's trail, records who closed it, and does it once", async () => {
    const id = (await (await requestsRoute.POST(post({ description: `${PREFIX} close`, reviewerName: "Ana", linkedInvoiceIds: bills }), ctx({}))).json()).id;

    const first = await (await closeRoute.POST(post({}, "Priya Shah"), ctx({ id }))).json();
    expect(first).toMatchObject({ success: true, alreadyClosed: false, closedBy: "Priya Shah", evidenceRecorded: 2 });

    const entries = await sql`SELECT invoice_id, agent_id, action_taken, triggered_by_actor FROM decisions WHERE idempotency_key LIKE ${`audit_assemble:${id}:%`}`;
    expect(entries).toHaveLength(2);
    expect(entries.every((e: any) => e.action_taken === "evidence_provided" && e.triggered_by_actor === "Priya Shah" && e.agent_id === "human:Priya Shah")).toBe(true);

    const again = await (await closeRoute.POST(post({}, "Sam Lee"), ctx({ id }))).json();
    expect(again).toMatchObject({ alreadyClosed: true, closedBy: "Priya Shah" });
    expect(await sql`SELECT id FROM decisions WHERE idempotency_key LIKE ${`audit_assemble:${id}:%`}`).toHaveLength(2);

    const listed = (await listFrontendPbcRequests()).find((r) => r.request_id === id);
    expect(listed).toMatchObject({ status: "closed", closed_by: "Priya Shah" });

    // What was handed over is fixed: nothing more can be attached to a closed request.
    const late = await filesRoute.POST(post({ filename: "late.txt", contentBase64: "aGk=", reviewerName: "Ana" }), ctx({ id }));
    expect(late.status).toBe(409);
    const [ev] = await listFrontendEvidenceRecords(id);
    expect(ev.agent_attestations).toContain("Evidence (person)");

    // The new trail entries are properly chained: each linked invoice's trail still verifies end to end.
    for (const billId of bills) {
      const seal = await sealRoute.POST(new Request("http://test", { method: "POST" }), ctx({ id: billId }));
      expect(seal.status).toBe(200);
    }
  });

  it("closing a request that does not exist is a 404", async () => {
    expect((await closeRoute.POST(post({ reviewerName: "Ana" }), ctx({ id: "no-such-request" }))).status).toBe(404);
  });
});

describe("asking about a request (POST /api/pbc/:id/narrate)", () => {
  it("validates the question before any AI call", async () => {
    const id = (await (await requestsRoute.POST(post({ description: `${PREFIX} ask`, reviewerName: "Ana" }), ctx({}))).json()).id;
    expect((await narrateRoute.POST(post({}), ctx({ id }))).status).toBe(400);
    expect((await narrateRoute.POST(post({ question: "x".repeat(501) }), ctx({ id }))).status).toBe(400);
    expect((await narrateRoute.POST(post({ question: "why?" }), ctx({ id: "no-such-request" }))).status).toBe(404);
    // No invoices linked: nothing to ask, and no AI call.
    expect(await (await narrateRoute.POST(post({ question: "why?" }), ctx({ id }))).json()).toEqual({ results: [], answeredFor: 0, totalLinked: 0 });
  });
});
