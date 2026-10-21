import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { aiClaims, uncheckedFigures } from "@/lib/agent/claim-check";
import { toFrontendInvoice } from "@/lib/api-shapes";
import { createBill } from "@/lib/bills";
import { readPurchaseOrder } from "@/lib/documents/purchase-order";
import { readGoodsReceipt } from "@/lib/documents/receipt";
import { textReading } from "@/lib/documents/reader-client";
import * as facts from "@/lib/matching/finding-facts";
import { canonicalUom } from "@/lib/matching/uom-dimension";
import { runMatchStage } from "@/lib/pipeline/match-stage";
import { createPurchaseOrder } from "@/lib/purchase-orders";
import { spreadTax, statedTaxRate } from "@/lib/tax-lines";

/**
 * What a live run of the test pack (three vendors: an Indian GST supplier, a blanket service order, a US lab supplier
 * with everything wrong) showed the software getting wrong, each fixed and pinned here through public functions.
 */

const sql = getSql();
const TAG = `TPF-${randomUUID().slice(0, 6)}`;

describe("an AI explanation's figures are checked against the records it was given", () => {
  // The Verifier's own words from the live run, and (a slice of) the records it had.
  const prose = "The total invoice amount is $1024 (300 units of gloves at 0.15 + 10 lab coats at 33.60 + 5 pipette tips at 48 = 45+336+240=621 pre-tax; 621*1.91 = 1186 does not reconcile to 1024). 2 receipts on 2026-10-20 for PO-NL-88213.";
  const records = { lines: [{ qty: 2000, unitPrice: 0.149, amount: 298 }, { qty: 10, unitPrice: 33.6, amount: 336 }, { qty: 5, unitPrice: 48, amount: 240 }], total: 1024, taxRate: 0.0825 };

  it("lists the figures that are in no record, and not the ones that are, nor counts, years, dates or identifiers", () => {
    // 0.15 is the 0.149 on file, rounded: not flagged.
    expect(uncheckedFigures(prose, records)).toEqual(["300", "45", "621", "1.91", "1186"]);
  });

  it("the record keeps the explanation, marks it unchecked, and says which figures to distrust", () => {
    const claims = aiClaims({ text: prose, evidence: records });
    expect(claims.map((c) => c.tag)).toEqual(["ungrounded", "ungrounded"]);
    expect(claims[1].text).toMatch(/not in the records it was given.*: 300, 45, 621, 1\.91, 1186\./);
    expect(aiClaims({ text: "Billed 2000 at 0.149; total 1024.", evidence: records })).toEqual([{ text: "Billed 2000 at 0.149; total 1024.", tag: "grounded" }]);
  });

  it("a person's challenge is answered first on the record, or the record says it was not answered", () => {
    const challenge = { by: "Devang", question: "only 8 lab coats were received, why does it show 18?" };
    expect(aiClaims({ text: "Block stands.", evidence: records, challenge, answer: "Two receipts are on file: 10 on 10/21 and 8 on 10/20; the first looks recorded by mistake." })[0])
      .toEqual({ text: "Answer to Devang: Two receipts are on file: 10 on 10/21 and 8 on 10/20; the first looks recorded by mistake.", tag: "grounded" });
    expect(aiClaims({ text: "Block stands.", evidence: records, challenge, answer: "" })[0])
      .toEqual({ text: `Devang's question was not answered by the AI: "${challenge.question}"`, tag: "ungrounded" });
  });
});

describe("units", () => {
  it("the same unit written differently is one unit; different units stay different", () => {
    expect(["Nos", "nos.", "PCS", "Each", "", null].map(canonicalUom)).toEqual(["each", "each", "each", "each", "each", "each"]);
    expect(["Pairs", "BOXES", "case", "Visit", "kgs", "furlong"].map(canonicalUom)).toEqual(["pair", "box", "case", "visit", "kg", "furlong"]);
  });

  it("an Indian PO in 'Nos' and its invoice in 'Nos' match cleanly; a PO in boxes billed in 'each' is a unit difference, not a 99% undercharge", async () => {
    const po = await createPurchaseOrder({ vendorName: `${TAG} Units`, poNumber: `${TAG}-U1`, receipt: { inFull: true, receiptDate: "2026-10-10" },
      lines: [{ description: "Hex Bolt M10x50", quantity: 500, unitPrice: 18.5, uom: "Nos" }, { description: "Nitrile Exam Gloves", quantity: 20, unitPrice: 14.9, uom: "box" }] });
    const bolts = await createBill({ vendorId: po.vendorId, poId: po.poId, invoiceNumber: `${TAG}-U1-A`, invoiceDate: "2026-10-12", strictTotals: true,
      lines: [{ description: "Hex Bolt M10x50", quantity: 500, unitPrice: 18.5, uom: "NOS" }] });
    expect((await runMatchStage(bolts.billId)).findings.filter((f) => f.action !== "auto_approve")).toEqual([]);

    const gloves = await createBill({ vendorId: po.vendorId, poId: po.poId, invoiceNumber: `${TAG}-U1-B`, invoiceDate: "2026-10-12", strictTotals: true,
      lines: [{ description: "Nitrile Exam Gloves", quantity: 2000, unitPrice: 0.149, uom: "each" }] });
    const r = await runMatchStage(gloves.billId);
    expect(r.findings.map((f) => f.code)).toEqual(["EXC-UOM_MISMATCH"]);
    expect(r.findings[0].shown?.points.map((p) => p.value)).toContain("ordered per box");
  });
});

describe("tax", () => {
  it("tax off its printed rate on three lines is ONE finding for the invoice, with the exact rate (8.25%, not 8.3%)", async () => {
    const po = await createPurchaseOrder({ vendorName: `${TAG} Tax`, poNumber: `${TAG}-T1`, currency: "USD", receipt: { inFull: true, receiptDate: "2026-10-10" },
      lines: [{ description: "Gloves", quantity: 20, unitPrice: 14.9 }, { description: "Lab Coat", quantity: 10, unitPrice: 32 }, { description: "Pipette Tips", quantity: 5, unitPrice: 48 }] });
    const items = [298, 320, 240];
    const stated = statedTaxRate([{ label: "Sales Tax (8.25%)", amount: 85 }])!;
    const bill = await createBill({ vendorId: po.vendorId, poId: po.poId, invoiceNumber: `${TAG}-T1-A`, invoiceDate: "2026-10-12", currency: "USD", tax: 85, strictTotals: true,
      lines: [{ description: "Gloves", quantity: 20, unitPrice: 14.9 }, { description: "Lab Coat", quantity: 10, unitPrice: 32 }, { description: "Pipette Tips", quantity: 5, unitPrice: 48 }],
      statedTax: { ...stated, perLine: spreadTax({ charged: 85, items, charges: [], discount: 0, rate: stated.rate })! } });
    const tax = (await runMatchStage(bill.billId)).findings.filter((f) => f.code === "EXC-TAX_VAR");
    expect(tax).toHaveLength(1);
    expect(tax[0].fact).toMatch(/^Tax on the 3 lines it applies to: tax charged USD 85\.00 \(9\.91% of the line\) against the 8\.25% of its tax code/);
    expect(tax[0].shown?.points.find((p) => p.source === "invoice" && p.label.startsWith("At the printed"))?.label).toBe("At the printed 8.25% rate");
  });
});

describe("money as it is printed", () => {
  it("a unit price keeps its third decimal, and INR is grouped the Indian way", () => {
    const shown = facts.priceVariance({ lineNumber: 1, description: "Gloves", uom: "each", billedPrice: 0.149, poPrice: 14.9, billedQty: 2000, variancePct: -0.99, impact: 29502, currency: "USD", action: "block" }).shown;
    expect(shown.points[0].value).toBe("USD 0.149 each");
    expect(facts.money(150000, "INR")).toBe("INR 1,50,000.00");
    expect(facts.money(150000, "USD")).toBe("USD 150,000.00");
  });
});

describe("a vendor's bank change holds only what is still to be paid", () => {
  it("an invoice already paid does not carry the hold or a 'bank account changed' problem", () => {
    const gate = { gating: true, status: "callback_pending", review: { id: "r", vendorId: "v", oldBankLast4: "3456", newBankLast4: "9887", status: "callback_pending", createdAt: "x" } } as any;
    const view = (status: string) => toFrontendInvoice({
      bill: { id: "b", invoice_number: "IFW/0418", status, total_amount: 35105, currency: "INR", received_at: "2026-10-13", invoice_date: "2026-10-13", due_date: null },
      vendorName: "Indus", taxId: null, paymentTermsCode: null, poNumber: null, decisions: [], lines: [], reasons: new Map(), gate,
    });
    expect(view("paid")).toMatchObject({ bankChange: null, mismatches: [] });
    expect(view("exception").bankChange).toMatchObject({ oldBankLast4: "3456", newBankLast4: "9887" });
  });
});

describe("reading", () => {
  it("an INR purchase order's day-first date is not flagged as ambiguous; one with no currency is", () => {
    const po = (extra: string) => readPurchaseOrder(textReading(`PURCHASE ORDER\nVendor: Indus Fastener Works\nPO Number: PO-NR-1\nOrder Date: 05-10-2026\n${extra}\n1. Hex Bolt\n   Qty: 500\n   Unit Price: 18.50`, "po.txt"));
    expect(po("Currency: INR (Rs.)").missing.filter((m) => m.includes("day/month"))).toEqual([]);
    expect(po("").missing.filter((m) => m.includes("day/month"))).toHaveLength(1);
  });

  it("'Received by' stops at the next label on the same line", () => {
    const r = readGoodsReceipt(textReading("DELIVERY CHALLAN\nDelivery Note No: DC-1\nDate: 12-10-2026\nPO Number: PO-1\n1. Hex Bolt  500 Nos\nReceived by: R. Yadav (Stores) Condition: Accepted", "dc.txt"));
    expect(r.receiverName).toBe("R. Yadav (Stores)");
  });
});

void sql;
