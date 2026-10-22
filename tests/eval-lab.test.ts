import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { createBill } from "@/lib/bills";
import { aiHonesty, assertLabSchema, runLab, type LabCase } from "@/lib/evals/lab";
import { writeDecision } from "@/lib/ledger/decisions";
import { checkMoneyRules } from "@/lib/evals/money-rules";
import { CASES } from "../eval/decisions/cases";
import { GET as quality } from "@/app/api/quality/route";
import { GET as listSaved, POST as saveSnapshot } from "@/app/api/quality/reports/route";
import { GET as savedReport } from "@/app/api/quality/reports/[id]/route";

/**
 * The evaluation itself, through its public entry points against the test schema: the lab run scores real pipeline
 * outcomes against labels (and fails when they differ), the money rules catch a breach planted in the database, the
 * lab refuses a schema that is not for evaluation, and the Quality API validates its input. Other suites share the
 * schema, so nothing here asserts whole-schema totals.
 */

vi.mock("@/lib/background", () => ({ runInBackground: vi.fn() }));
beforeAll(() => vi.stubEnv("GROQ_API_KEY", ""));
afterEach(() => vi.unstubAllEnvs());

const sql = getSql();
const pick = (...ids: string[]) => ids.map((id) => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no lab case ${id}`);
  return c;
});

describe("the lab run", () => {
  it("refuses any schema not made for evaluation: the cases create invoices and payments", () => {
    vi.stubEnv("DB_SCHEMA", "veribook_demo");
    expect(() => assertLabSchema()).toThrow(/only runs in a schema ending in _eval or _test/);
    vi.stubEnv("DB_SCHEMA", "");
    expect(() => assertLabSchema()).toThrow(/unset: the live schema/);
  });

  it("scores each case against its label, through the real pipeline, and fails the run when one is decided differently", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const mislabelled: LabCase = { ...pick("price-8pct")[0], id: "mislabelled-8pct", expect: { outcome: "approved", stage: null } };
    const broken: LabCase = { ...pick("clean-full")[0], id: "broken-setup", build: async () => { throw new Error("no such fixture"); } };
    const report = await runLab({ cases: [...pick("clean-full", "trick-near-duplicate", "duplicate-exact", "bank-changed"), mislabelled, broken], ai: false });

    const byId = Object.fromEntries(report.cases!.map((c) => [c.id, c]));
    expect(byId["clean-full"]).toMatchObject({ outcomeOk: true, reasonOk: true, actionOk: true, got: { outcome: "approved", reason: "CLEAN_MATCH" } });
    expect(byId["trick-near-duplicate"]).toMatchObject({ outcomeOk: true, reasonOk: true, got: { outcome: "held", reason: "EXC-DUPLICATE", caughtBy: "validate" } });
    expect(byId["duplicate-exact"]).toMatchObject({ outcomeOk: true, got: { outcome: "refused", found: ["EXC-DUPLICATE"] }, invoiceId: null });
    expect(byId["bank-changed"]).toMatchObject({ outcomeOk: true, reasonOk: true, actionOk: true, got: { reason: "EXC-FRAUD_BANK", action: "block_fraud_flag" } });
    expect(byId["mislabelled-8pct"]).toMatchObject({ outcomeOk: false, got: { outcome: "held" } });
    expect(byId["broken-setup"]).toMatchObject({ outcomeOk: false, error: "setup failed: no such fixture" });

    expect(report.verdict).toBe("fail");
    expect(report.targets.find((t) => t.key === "policy_agreement")).toMatchObject({ met: false, actual: "66.7% (4 of 6)" });
    expect(report.money).toMatchObject({ wronglyPaid: 0, wronglyHeld: 1, silentErrors: 0 });
    expect(report.money.rules.every((r) => r.broken === 0)).toBe(true);
    expect(report.failures.map((f) => [f.id, f.kind])).toEqual([["mislabelled-8pct", "wrongly_held"], ["broken-setup", "crash"]]);
    expect(report.journeys.find((j) => j.key === "duplicates")).toMatchObject({ entered: 2, correct: 2, ended: { refused: 1, held: 1 } });
    expect(report.operations.find((o) => o.key === "validate")).toMatchObject({ correct: expect.any(Number), judged: expect.any(Number) });
  }, 180_000);

  it("every lab case has a unique id and names the policy section its answer comes from", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) expect(c.rule.length, c.id).toBeGreaterThan(3);
  });
});

describe("the money rules", () => {
  it("catch money paid on an invoice that is held, from the database itself", async () => {
    const TAG = `EL-${randomUUID().slice(0, 6)}`;
    const bill = await createBill({ vendorName: `${TAG} Vendor`, invoiceNumber: `${TAG}-1`, strictTotals: true, lines: [{ description: "Service", quantity: 1, unitPrice: 300 }] });
    await sql`UPDATE vendor_bills SET status = 'exception' WHERE id = ${bill.billId}`;
    const pay = randomUUID();
    await sql`INSERT INTO payments (id, payment_date, total_amount) VALUES (${pay}, ${new Date().toISOString().slice(0, 10)}, 300)`;
    await sql`INSERT INTO payment_applications (id, payment_id, vendor_bill_id, applied_amount) VALUES (${randomUUID()}, ${pay}, ${bill.billId}, 300)`;

    const rules = Object.fromEntries((await checkMoneyRules([bill.billId])).map((r) => [r.key, r.breaches]));
    expect(rules.paid_only_when_approved).toEqual([{ invoiceId: bill.billId, invoiceNumber: `${TAG}-1`, detail: "300 paid while the invoice is 'exception'" }]);
    expect(rules.held_says_why).toHaveLength(1); // held, and no policy decision says why
    expect(rules.credit_never_paid).toEqual([]);
  });

  it("an empty set is checked without touching the database, and every rule is still listed", async () => {
    expect((await checkMoneyRules([])).map((r) => r.breaches.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("the AI's record", () => {
  it("a failed AI step (the free quota ran out) is counted as a failure, never as an AI explanation or judgement", async () => {
    const TAG = `EA-${randomUUID().slice(0, 6)}`;
    const bill = await createBill({ vendorName: `${TAG} Vendor`, invoiceNumber: `${TAG}-1`, strictTotals: true, lines: [{ description: "Service", quantity: 1, unitPrice: 100 }] });
    const now = new Date().toISOString();
    await writeDecision({ invoiceId: bill.billId, nodeId: "investigate", agentId: "investigator", model: "openai/gpt-oss-120b", startedAt: now, endedAt: now, actionTaken: "error", reasonCode: "R99_AGENT_ERROR",
      claims: [{ text: "Investigator failed: The AI provider's daily usage limit was reached.", tag: "grounded" }], idempotencyKey: `${TAG}-inv` });
    expect(await aiHonesty([bill.billId])).toMatchObject({ aiFailed: 1, aiExplanations: 0, aiHolds: 0 });
  });
});

describe("the Quality API", () => {
  const today = new Date().toISOString().slice(0, 10);
  const get = (url: string) => quality(new Request(`http://t/api/quality${url}`), undefined as never);

  it("reports the period's real invoices, with the saved reports and the found-by-testing log", async () => {
    const res = await get(`?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.field).toMatchObject({ kind: "field", mode: "field", period: { from: today, to: today } });
    expect(body.field.logistics.invoices).toBeGreaterThan(0);
    expect(body.foundByEvals.length).toBeGreaterThan(5);
    expect(body.reasonTitles["EXC-PRICE_VAR"]).toBe("Price differs from the order");
  }, 60_000);

  it("refuses a bad date, a reversed period, and one over a year", async () => {
    expect((await get("?from=2026-13-01")).status).toBe(400);
    expect((await get("?from=2026-10-10&to=2026-10-01")).status).toBe(400);
    expect((await get("?from=2024-01-01&to=2026-01-01")).status).toBe(400);
  });

  it("saves a snapshot and gives it back in full, as data to download too; an unknown or malformed id is refused", async () => {
    const created = await saveSnapshot(new Request("http://t/api/quality/reports", { method: "POST", body: JSON.stringify({ from: today, to: today }) }), undefined as never);
    expect(created.status).toBe(201);
    const { id } = await created.json();

    const one = await savedReport(new Request(`http://t/api/quality/reports/${id}`), { params: Promise.resolve({ id }) });
    expect((await one.json()).report).toMatchObject({ kind: "field", period: { from: today, to: today } });
    const file = await savedReport(new Request(`http://t/api/quality/reports/${id}?format=json`), { params: Promise.resolve({ id }) });
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="veribook-field-report-\d{4}-\d{2}-\d{2}\.json"$/);

    const list = await (await listSaved(new Request("http://t/api/quality/reports?kind=field"), undefined as never)).json();
    expect(list.reports.map((r: { id: string }) => r.id)).toContain(id);
    expect((await listSaved(new Request("http://t/api/quality/reports?kind=nope"), undefined as never)).status).toBe(400);

    const unknown = randomUUID();
    expect((await savedReport(new Request("http://t/x"), { params: Promise.resolve({ id: unknown }) })).status).toBe(404);
    expect((await savedReport(new Request("http://t/x"), { params: Promise.resolve({ id: "../../etc" }) })).status).toBe(400);
  }, 60_000);
});
