import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchReceiptToPo, readGoodsReceipt, type ReceiptDraft } from "@/lib/documents/receipt";
import { textReading, type Reading } from "@/lib/documents/reader-client";
import { descriptionSimilarity } from "@/lib/matching/line-match";

/**
 * Goods-receipt documents (delivery challan, GRN, packing slip) read on REAL reader output: the saved readings in
 * eval/documents/readings/ are what Docling + OCR returned for the generated receipt set (digital, scanned, messy
 * scan, phone photo), so the rules run on genuine OCR text and positions without the reader or a database.
 */

const ROOT = join(process.cwd(), "eval", "documents", "goods_receipts");
function reading(layout: string, form: string): Reading {
  const bytes = readFileSync(join(ROOT, layout, form));
  return JSON.parse(readFileSync(join(ROOT, "..", "readings", `${createHash("sha256").update(bytes).digest("hex")}.json`), "utf8"));
}
const truth = (layout: string) => JSON.parse(readFileSync(join(ROOT, layout, "truth.json"), "utf8"));

const ALL: Array<[string, string]> = [
  ["gr_challan", "digital.pdf"], ["gr_challan", "scan_clean.pdf"], ["gr_challan", "photo.jpg"],
  ["gr_grn", "digital.pdf"], ["gr_grn", "scan_messy.pdf"],
  ["gr_packing_slip", "digital.pdf"], ["gr_packing_slip", "photo.jpg"],
];

describe("goods receipt documents on real readings", () => {
  it.each(ALL)("%s/%s: PO number, document number, date, receiver and every quantity match the answer key", (layout, form) => {
    const t = truth(layout);
    const d = readGoodsReceipt(reading(layout, form));
    expect({ poNumber: d.poNumber, documentNumber: d.documentNumber, receiptDate: d.receiptDate, receiverName: d.receiverName })
      .toEqual({ poNumber: t.po_number, documentNumber: t.document_number, receiptDate: t.receipt_date, receiverName: t.receiver_name });
    expect(d.lines.map((l) => l.quantity)).toEqual(t.line_items.map((l: any) => l.quantity));
    // descriptions as OCR read them ("Zinc Piated" on the photo): close enough to find the PO line, checked below
    d.lines.forEach((l, i) => expect(descriptionSimilarity(l.description, t.line_items[i].description)).toBeGreaterThan(0.75));
    expect(d.lines.every((l) => l.problem === null)).toBe(true);
  });

  it("takes the quantity that came in: Accepted on a GRN (not Received, which includes the rejected), Shipped on a packing slip, never Ordered or Backordered", () => {
    const grn = readGoodsReceipt(reading("gr_grn", "digital.pdf"));
    expect(grn.quantityColumn).toBe("Accepted");
    expect(grn.lines.map((l) => [l.quantity, l.rejected, l.ordered])).toEqual([[24, 1, 25], [4.5, 0, 4.5], [40, 0, 40]]);
    expect(grn.lines[0].remark).toBe("1 kg bag torn");

    const slip = readGoodsReceipt(reading("gr_packing_slip", "photo.jpg"));
    expect(slip.quantityColumn).toBe("Qty Shipped");
    expect(slip.lines.map((l) => [l.code, l.quantity, l.ordered])).toEqual([["CYL-50-200", 4, 4], ["AH-38-25", 8, 10], ["PR-14-G", 2, 2]]);
  });

  it("regression: an OCR slip in the table ('4:500' for 4.500 on the messy scan) is read as 4.500, confirmed by received = accepted + rejected", () => {
    const d = readGoodsReceipt(reading("gr_grn", "scan_messy.pdf"));
    expect(d.lines[1]).toMatchObject({ description: "Green Cardamom 8 mm Bold", quantity: 4.5, problem: null });
  });

  it("a note printed under the table ('Balance 4 Pairs ... to follow') is not glued onto the last item, and ends the table", () => {
    const d = readGoodsReceipt(reading("gr_challan", "scan_clean.pdf"));
    expect(d.lines).toHaveLength(4);
    expect(d.lines[3].description).toBe("Safety Gloves, Cut Resistant (Level 5)");
  });

  it("says which date it read: a GRN date is the day goods came in; a challan or ship date is when they were sent", () => {
    expect(readGoodsReceipt(reading("gr_grn", "digital.pdf"))).toMatchObject({ dateLabel: "GRN Date", dateKind: "received" });
    expect(readGoodsReceipt(reading("gr_challan", "digital.pdf"))).toMatchObject({ dateLabel: "Date", dateKind: "document" });
    expect(readGoodsReceipt(reading("gr_packing_slip", "digital.pdf"))).toMatchObject({ dateLabel: "Ship Date", dateKind: "document" });
  });

  it("an OCR'd document says so in `missing`; a digital one with every field found has nothing to report", () => {
    expect(readGoodsReceipt(reading("gr_grn", "digital.pdf")).missing).toEqual([]);
    expect(readGoodsReceipt(reading("gr_grn", "scan_messy.pdf")).missing.join(" ")).toMatch(/read by OCR/);
  });
});

describe("goods receipt from pasted text", () => {
  const NOTE = [
    "DELIVERY NOTE",
    "Delivery Note No: DN-5521",
    "Date: 03/04/2026",
    "PO No: PO-88123",
    "| Item | Qty Delivered | Unit |",
    "|---|---|---|",
    "| Copier paper A4 80gsm | 40 | Ream |",
    "| Toner cartridge TN-2410 | 2 | Pcs |",
    "Received by: Meera",
  ].join("\n");

  it("reads a markdown table and labelled fields", () => {
    const d = readGoodsReceipt(textReading(NOTE));
    expect(d).toMatchObject({ documentNumber: "DN-5521", poNumber: "PO-88123", receiverName: "Meera", quantityColumn: "Qty Delivered" });
    expect(d.lines.map((l) => [l.description, l.quantity, l.uom])).toEqual([["Copier paper A4 80gsm", 40, "Ream"], ["Toner cartridge TN-2410", 2, "Pcs"]]);
  });

  it("an all-number date with nothing to say which way round it is gets flagged; the PO's currency settles it", () => {
    const unsure = readGoodsReceipt(textReading(NOTE));
    expect(unsure.missing.join(" ")).toMatch(/03\/04\/2026 could be day-first or month-first/);
    const indian = readGoodsReceipt(textReading(NOTE), { currencyHint: "INR" });
    expect(indian.receiptDate).toBe("2026-04-03");
    expect(indian.missing.join(" ")).not.toMatch(/day-first/);
    expect(readGoodsReceipt(textReading(NOTE), { currencyHint: "USD" }).receiptDate).toBe("2026-03-04");
  });

  it("a document with no item table says so instead of returning an empty receipt silently", () => {
    const d = readGoodsReceipt(textReading("Delivery Note No: DN-1\nPO No: PO-1\nGoods delivered as ordered."));
    expect(d.lines).toEqual([]);
    expect(d.missing.join(" ")).toMatch(/item lines/);
  });
});

describe("matching a receipt document to the PO's lines", () => {
  const PO = {
    poNumber: "PO-2026-0871",
    lines: [
      { lineNumber: 1, description: "Hex Bolt M10 x 50 (Zinc Plated)", uom: "Nos", ordered: 500, received: 0 },
      { lineNumber: 2, description: "Spring Washer M10", uom: "Nos", ordered: 500, received: 0 },
      { lineNumber: 3, description: "Industrial Grease 1 kg (Lithium Complex)", uom: "Nos", ordered: 12, received: 0 },
      { lineNumber: 4, description: "Safety Gloves, Cut Resistant (Level 5)", uom: "Pairs", ordered: 24, received: 0 },
    ],
  };
  const draft = (lines: Array<[string, number | null]>, poNumber: string | null = "PO-2026-0871"): ReceiptDraft => ({
    documentNumber: "DC-1", poNumber, receiptDate: "2026-09-10", dateLabel: "Date", dateKind: "document", receiverName: null, quantityColumn: "Quantity", missing: [],
    lines: lines.map(([description, quantity]) => ({ description, quantity, code: null, uom: null, ordered: null, rejected: null, remark: null, problem: null })),
  });

  it("the challan photo (OCR'd names) fills every PO line, each matched with confidence, and has nothing to warn about", () => {
    const m = matchReceiptToPo(readGoodsReceipt(reading("gr_challan", "photo.jpg")), PO);
    expect(m.poLines.map((l) => [l.lineNumber, l.quantity, l.sure])).toEqual([[1, 500, true], [2, 500, true], [3, 12, true], [4, 20, true]]);
    expect(m.unmatched).toEqual([]);
    expect(m.warnings).toEqual([]);
  });

  it("lines are matched by name, not position: a document listing the items in another order still fills the right lines", () => {
    const m = matchReceiptToPo(draft([["Safety Gloves Cut Resistant L5", 4], ["Hex Bolt M10x50 ZP", 100]]), PO);
    expect(m.poLines.map((l) => l.quantity)).toEqual([100, null, null, 4]);
    expect(m.poLines[0].sure).toBe(false); // "M10x50 ZP" is a loose match: the form says check it
    expect(m.warnings.join(" ")).toMatch(/Line 1 was matched to "Hex Bolt M10x50 ZP" by a similar name/);
  });

  it("never matches an item whose size differs, however alike the names (M12 washers are not the M10 washers ordered)", () => {
    const m = matchReceiptToPo(draft([["Spring Washer M12", 500]]), PO);
    expect(m.poLines.every((l) => l.quantity === null)).toBe(true);
    expect(m.unmatched).toEqual([{ documentLine: 1, description: "Spring Washer M12", quantity: 500 }]);
    expect(m.warnings.join(" ")).toMatch(/"Spring Washer M12" \(500\) matches no line on this PO/);
  });

  it("warns when more came in than is still due (counting what was received before), and when the document cites another PO", () => {
    const already = { ...PO, lines: PO.lines.map((l) => (l.lineNumber === 4 ? { ...l, received: 20 } : l)) };
    const m = matchReceiptToPo(draft([["Safety Gloves, Cut Resistant (Level 5)", 10]], "PO-2026-0999"), already);
    expect(m.poLines[3].quantity).toBe(10);
    expect(m.warnings.join(" ")).toMatch(/document says 10 came in, but only 4 of the 24 ordered are still due/);
    expect(m.warnings.join(" ")).toMatch(/cites purchase order PO-2026-0999, not PO-2026-0871/);
  });

  it("a GRN's rejected quantity is pointed out: only the accepted quantity is filled in", () => {
    const grn = readGoodsReceipt(reading("gr_grn", "digital.pdf"));
    const m = matchReceiptToPo(grn, {
      poNumber: "PO-2026-0962",
      lines: grn.lines.map((l, i) => ({ lineNumber: i + 1, description: l.description, uom: l.uom, ordered: l.ordered ?? 0, received: 0 })),
    });
    expect(m.poLines.map((l) => l.quantity)).toEqual([24, 4.5, 40]);
    expect(m.warnings).toEqual(["Line 1: 1 rejected (1 kg bag torn); only the accepted quantity is filled in."]);
  });
});
