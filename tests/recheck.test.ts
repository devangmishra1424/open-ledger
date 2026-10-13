import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSql } from "@/db/client";
import { HttpError } from "@/lib/http";

/**
 * Re-checking an invoice when its PO or goods receipt change after it was saved (lib/pipeline/recheck.ts), through
 * the real routes and the real (test-schema) database. The two AI agents return fixed answers here (the real ones
 * are covered by the live suites), so each outcome comes from the deterministic rules and is repeatable. Background
 * work is captured and awaited, so a test sees the finished re-check.
 */

const background: Array<Promise<unknown>> = [];
vi.mock("@/lib/background", () => ({
  runInBackground: vi.fn((_label: string, task: () => Promise<unknown>) => { background.push(task().catch((e) => e)); }),
}));
const investigateCalls: unknown[][] = [];
vi.mock("@/lib/agent/investigator", () => ({
  investigate: vi.fn(async (...args: unknown[]) => {
    investigateCalls.push(args);
    return { submission: { exception_types: [], confidence: 0.95, rationale: "Matches the PO and the receipt.", recommended_action: "auto_approve" }, toolCalls: [], turns: 1, model: "test-investigator" };
  }),
}));
vi.mock("@/lib/agent/verifier", () => ({
  verify: vi.fn(async () => ({ submission: { agrees: true, exception_types: [], confidence: 0.9, notes: "Agreed." }, toolCalls: [], turns: 1, model: "test-verifier" })),
}));

const { createBill } = await import("@/lib/bills");
const { runPipeline } = await import("@/lib/pipeline/orchestrator");
const { startRecheck, AUTOMATIC } = await import("@/lib/pipeline/recheck");
const { getDecisionsForInvoice, writeDecision } = await import("@/lib/ledger/decisions");
const { verifyInvoiceTrail } = await import("@/lib/ledger/trail");
const poRoute = await import("@/app/api/purchase-orders/route");
const receiptRoute = await import("@/app/api/purchase-orders/[id]/receipts/route");
const recheckRoute = await import("@/app/api/invoices/[id]/recheck/route");

const sql = getSql();
const settle = async () => { while (background.length) await Promise.all(background.splice(0)); };
const json = (body: unknown) => new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const live = async (id: string) => (await getDecisionsForInvoice(id)).filter((d) => !d.supersededById);
const liveMatch = async (id: string) => (await live(id)).filter((d) => d.nodeId === "match").at(-1);
const status = async (id: string) => (await sql`SELECT status, po_id, po_reference FROM vendor_bills WHERE id = ${id}`)[0];

const LINES = [{ description: "Hex Bolt M10 x 50", quantity: 100, unitPrice: 6.4 }, { description: "Spring Washer M10", quantity: 100, unitPrice: 0.85 }];
const ITEMS = LINES.map((l) => ({ description: l.description, qty: l.quantity, rate: l.unitPrice }));

async function invoice(vendor: string, poNumber: string | null, invoiceDate = "2026-09-12") {
  const { billId } = await createBill({ vendorName: vendor, poNumber, invoiceNumber: `INV-${tag()}`, invoiceDate, currency: "INR", lines: LINES, tax: 0, total: 725, strictTotals: true });
  await runPipeline(billId);
  return billId;
}
const addPo = (vendor: string, poNumber: string, receipt?: object) =>
  poRoute.POST(json({ vendor, poNumber, orderDate: "2026-09-01", currency: "INR", items: ITEMS, ...(receipt ? { receipt } : {}) }), undefined as never);

beforeEach(() => { background.length = 0; investigateCalls.length = 0; });

describe("an invoice saved before its purchase order", () => {
  it("is linked and checked again when the PO is added: same PO number, same vendor", async () => {
    const vendor = `Recheck Vendor ${tag()}`;
    const po = `PO-RC-${tag()}`;
    const billId = await invoice(vendor, po);
    expect((await liveMatch(billId))?.reasonCode).toBe("EXC-NON_PO");
    expect(await status(billId)).toMatchObject({ status: "exception", po_id: null, po_reference: po });
    const extractBefore = (await live(billId)).find((d) => d.nodeId === "extract")!;

    const res = await addPo(vendor, po, { receivedInFull: true, receiptDate: "2026-09-10" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.recheckedInvoices.map((i: any) => i.id)).toEqual([billId]);
    await settle();

    const after = await status(billId);
    expect(after.po_id).toBe(body.poId);
    const match = await liveMatch(billId);
    expect(match?.reasonCode).toBe("CLEAN_MATCH");
    const run = await live(billId);
    const validate = run.find((d) => d.nodeId === "validate")!;
    expect(validate.claims?.[0]?.text).toBe(`Re-checked because purchase order ${po} was added.`);
    expect(validate.claims?.[1]?.text).toMatch(new RegExp(`Linked to purchase order ${po}`));
    expect(validate.triggeredByActor).toBe(AUTOMATIC);
    // the reading is kept; the old run is superseded (still on the chain), and the chain still verifies
    expect(run.find((d) => d.nodeId === "extract")?.id).toBe(extractBefore.id);
    const old = (await getDecisionsForInvoice(billId)).filter((d) => d.supersededById);
    expect(old.map((d) => d.nodeId)).toEqual(expect.arrayContaining(["validate", "match", "policy", "audit"]));
    expect((await verifyInvoiceTrail(billId))?.valid).toBe(true);
    // a re-check is not put to the AI as a person's question
    expect(investigateCalls.at(-1)?.[2]).toBeUndefined();
  });

  it("is not linked to a PO with the same number from another vendor", async () => {
    const po = `PO-RC-${tag()}`;
    const billId = await invoice(`Vendor A ${tag()}`, po);
    const res = await addPo(`Vendor B ${tag()}`, po);
    expect((await res.json()).recheckedInvoices).toEqual([]);
    await settle();
    expect(await status(billId)).toMatchObject({ status: "exception", po_id: null });
  });

  it("a person can link a PO the invoice did not print, but only one on file for the same vendor", async () => {
    const vendor = `Recheck Vendor ${tag()}`;
    const billId = await invoice(vendor, null);
    const po = `PO-RC-${tag()}`;
    await addPo(vendor, po, { receivedInFull: true, receiptDate: "2026-09-10" });
    const other = `PO-RC-${tag()}`;
    await addPo(`Someone Else ${tag()}`, other);
    await settle();

    const wrong = await recheckRoute.POST(json({ reviewerName: "Asha", poNumber: other }), ctx(billId));
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error).toMatch(new RegExp(`no purchase order ${other} is on file for ${vendor}`));
    expect(await status(billId)).toMatchObject({ status: "exception", po_id: null }); // nothing changed

    const ok = await recheckRoute.POST(json({ reviewerName: "Asha", poNumber: po }), ctx(billId));
    expect(ok.status).toBe(202);
    expect((await ok.json()).linkedPo).toMatchObject({ poNumber: po });
    await settle();
    expect((await liveMatch(billId))?.reasonCode).toBe("CLEAN_MATCH");
    const validate = (await live(billId)).find((d) => d.nodeId === "validate")!;
    expect(validate.claims?.[0]?.text).toBe("Re-checked at Asha's request.");
    expect(validate.triggeredByActor).toBe("Asha");
  });
});

describe("an invoice stopped because the goods had not arrived", () => {
  it("is checked again when an accepted receipt is recorded; a damaged one does not clear it", async () => {
    const vendor = `Recheck Vendor ${tag()}`;
    const po = `PO-RC-${tag()}`;
    const created = await (await addPo(vendor, po)).json();
    await settle();
    const billId = await invoice(vendor, po);
    expect((await liveMatch(billId))?.claims?.map((c) => c.text).join(" ")).toMatch(/EXC-BEFORE_RCV/);

    const damaged = await (await receiptRoute.POST(json({ receivedInFull: true, receiptDate: "2026-09-10", condition: "damaged" }), ctx(created.poId))).json();
    expect(damaged.recheckedInvoices).toEqual([]);

    const accepted = await (await receiptRoute.POST(json({ receivedInFull: true, receiptDate: "2026-09-10" }), ctx(created.poId))).json();
    expect(accepted.recheckedInvoices.map((i: any) => i.id)).toEqual([billId]);
    await settle();
    const match = await liveMatch(billId);
    expect(match?.claims?.map((c) => c.text).join(" ") ?? "").not.toMatch(/EXC-BEFORE_RCV/);
    expect((await live(billId)).find((d) => d.nodeId === "validate")?.claims?.[0]?.text).toMatch(/because goods were received against purchase order/);
  });
});

describe("what a re-check never does", () => {
  it("never re-checks a decided invoice (rejected here), and says why", async () => {
    const billId = await invoice(`Recheck Vendor ${tag()}`, null);
    await sql`UPDATE vendor_bills SET status = 'void' WHERE id = ${billId}`;
    const res = await recheckRoute.POST(json({ reviewerName: "Asha" }), ctx(billId));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/rejected/);
  });

  it("never supersedes a person's decision", async () => {
    const vendor = `Recheck Vendor ${tag()}`;
    const billId = await invoice(vendor, null);
    const now = new Date().toISOString();
    const human = await writeDecision({ invoiceId: billId, nodeId: "human_review", agentId: "human:Ravi", startedAt: now, endedAt: now, actionTaken: "contest", claims: [{ text: "Asked for another look.", tag: "grounded" }], idempotencyKey: `human-${billId}` });
    await startRecheck(billId, { kind: "manual", by: "Ravi" });
    await settle();
    const after = (await getDecisionsForInvoice(billId)).find((d) => d.id === human.id)!;
    expect(after.supersededById).toBeUndefined();
  });

  it("two re-checks at once: one runs, the other is refused (the invoice is claimed under a row lock)", async () => {
    const billId = await invoice(`Recheck Vendor ${tag()}`, null);
    const results = await Promise.allSettled([startRecheck(billId, { kind: "manual", by: "A" }), startRecheck(billId, { kind: "manual", by: "B" })]);
    await settle();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(HttpError);
    expect((refused.reason as HttpError).status).toBe(409);
  });
});
