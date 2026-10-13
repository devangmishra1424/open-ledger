import { describe, it, expect, afterAll } from "vitest";
import { getSql } from "@/db/client";
import { attestationLabels, listFrontendEvidenceRecords, listFrontendPbcRequests } from "@/lib/pbc-shapes";

describe("audit requests as the Audit page sees them (real DB, no LLM)", () => {
  const sql = getSql();
  const PREFIX = "TEST-PBC-SHAPES";
  const ids: string[] = [];
  const created = { vendorId: "", billId: "" };

  afterAll(async () => {
    if (ids.length) await sql`DELETE FROM pbc_requests WHERE id = ANY(${ids})`;
    if (created.billId) await sql`DELETE FROM vendor_bills WHERE id = ${created.billId}`;
    if (created.vendorId) await sql`DELETE FROM vendors WHERE id = ${created.vendorId}`;
  });

  it("regression: a request with no invoices linked is 'none', not a reassuring 'matched'", async () => {
    const id = crypto.randomUUID();
    ids.push(id);
    await sql`INSERT INTO pbc_requests (id, item_type, description, status, linked_invoice_ids) VALUES (${id}, 'invoice_bundle', ${PREFIX + " empty"}, 'open', '')`;
    const req = (await listFrontendPbcRequests()).find((r) => r.request_id === id);
    expect(req).toMatchObject({ tie_out_status: "none", linked_count: 0 });
  });

  it("an evidence record names the invoice by the number printed on it, not only the internal id", async () => {
    created.vendorId = crypto.randomUUID();
    await sql`INSERT INTO vendors (id, name) VALUES (${created.vendorId}, ${PREFIX + " Vendor"})`;
    created.billId = crypto.randomUUID();
    await sql`
      INSERT INTO vendor_bills (id, vendor_id, invoice_number, invoice_date, currency, subtotal, total_amount, status)
      VALUES (${created.billId}, ${created.vendorId}, ${PREFIX + "-INV-1"}, '2026-09-01', 'USD', 120, 120, 'posted')`;
    const id = crypto.randomUUID();
    ids.push(id);
    await sql`INSERT INTO pbc_requests (id, item_type, description, status, linked_invoice_ids) VALUES (${id}, 'invoice_bundle', ${PREFIX + " one"}, 'open', ${created.billId})`;

    const req = (await listFrontendPbcRequests()).find((r) => r.request_id === id);
    expect(req).toMatchObject({ tie_out_status: "matched", linked_count: 1 });
    const [ev] = await listFrontendEvidenceRecords(id);
    expect(ev).toMatchObject({ invoice_id: created.billId, invoice_number: PREFIX + "-INV-1", vendor: PREFIX + " Vendor", currency: "USD" });
  });
});

describe("audit evidence: who stood behind each step (attestationLabels)", () => {
  it("says rules for deterministic code, AI for a model, person for a human, once per stage", () => {
    const labels = attestationLabels([
      { node_id: "extract", agent_id: "deterministic-parser", action_taken: "parsed" },
      { node_id: "validate", agent_id: "deterministic-validator", action_taken: "pass" },
      { node_id: "match", agent_id: "deterministic-matching-engine", action_taken: "escalate_l1" },
      { node_id: "investigate", agent_id: "openai/gpt-oss-120b", action_taken: "escalate_l1" },
      { node_id: "policy", agent_id: "deterministic-policy-engine", action_taken: "escalate_l1" },
      { node_id: "human_review", agent_id: "Priya Shah", action_taken: "human_approved" },
      { node_id: "human_review", agent_id: "Sam Lee", action_taken: "human_approved" },
      { node_id: "audit", agent_id: "system", action_taken: "error" },
    ]);
    expect(labels).toEqual(["Read (rules)", "Gates (rules)", "Match (rules)", "Investigator (AI)", "Policy (rules)", "Reviewer (person)", "Record (rules)"]);
  });
  it("never calls the rule engine an agent, and skips steps that recorded no action", () => {
    const labels = attestationLabels([
      { node_id: "match", agent_id: "deterministic-matching-engine", action_taken: "auto_approve" },
      { node_id: "verify", agent_id: "qwen/qwen3", action_taken: null },
    ]);
    expect(labels).toEqual(["Match (rules)"]);
    expect(labels.join(" ")).not.toMatch(/Agent/);
  });
});
