import { describe, it, expect } from "vitest";
import { buildThreeWay, type ThreeWayInput } from "@/lib/three-way";

const base = (over: Partial<ThreeWayInput> = {}): ThreeWayInput => ({
  po: { po_number: "PO-1", status: "open", po_type: "standard", currency: "USD", max_value_ceiling: null },
  poLines: [{ id: "pl1", line_number: 1, description: "Cloud GPU Compute Cluster", uom: "each", qty_ordered: 4, unit_price: 2500, tolerance_pct: 0.02 }],
  receipts: [{ id: "r1", receipt_date: "2026-10-05", receiver_name: "W. Novak", condition: "accepted", final_delivery_indicator: true }],
  receiptLines: [{ goods_receipt_id: "r1", po_line_id: "pl1", qty_received: 4 }],
  billLines: [{ id: "b1", description: "Cloud GPU Compute Cluster", uom: "each", qty_invoiced: 4, unit_price: 2500 }],
  ...over,
});

describe("buildThreeWay", () => {
  it("a clean match shows ordered, received and invoiced agreeing, with no flags", () => {
    const t = buildThreeWay(base());
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toMatchObject({ qtyOrdered: 4, qtyReceived: 4, unitPrice: 2500, flags: [], priceVariancePct: 0, qtyVsReceived: 0 });
    expect(t.lines[0].invoice).toMatchObject({ qty: 4, unitPrice: 2500, amount: 10000 });
    expect(t.totals).toEqual({ ordered: 10000, received: 10000, invoiced: 10000 });
  });

  it("flags a price above the line's tolerance and reports the variance", () => {
    const t = buildThreeWay(base({ billLines: [{ id: "b1", description: "Cloud GPU Compute Cluster", uom: "each", qty_invoiced: 4, unit_price: 2875 }] }));
    expect(t.lines[0].flags).toEqual(["price_over"]);
    expect(t.lines[0].priceVariancePct).toBe(0.15);
  });

  it("a price inside tolerance is not flagged (2% allowed)", () => {
    const t = buildThreeWay(base({ billLines: [{ id: "b1", description: "Cloud GPU Compute Cluster", uom: "each", qty_invoiced: 4, unit_price: 2540 }] }));
    expect(t.lines[0].flags).toEqual([]);
  });

  it("flags billing for more than was received", () => {
    const t = buildThreeWay(base({ receiptLines: [{ goods_receipt_id: "r1", po_line_id: "pl1", qty_received: 3 }] }));
    expect(t.lines[0].flags).toEqual(["qty_over_received"]);
    expect(t.lines[0].qtyVsReceived).toBe(1);
  });

  it("does not count damaged or rejected deliveries as received", () => {
    const t = buildThreeWay(base({
      receipts: [
        { id: "r1", receipt_date: "2026-10-05", receiver_name: null, condition: "accepted", final_delivery_indicator: false },
        { id: "r2", receipt_date: "2026-10-06", receiver_name: null, condition: "damaged", final_delivery_indicator: false },
      ],
      receiptLines: [{ goods_receipt_id: "r1", po_line_id: "pl1", qty_received: 2 }, { goods_receipt_id: "r2", po_line_id: "pl1", qty_received: 2 }],
    }));
    expect(t.lines[0].qtyReceived).toBe(2);
    expect(t.lines[0].flags).toContain("qty_over_received");
    expect(t.receipts.map((r) => r.condition)).toEqual(["accepted", "damaged"]); // still listed, so the reviewer can see them
  });

  it("flags billing for goods with nothing received, and for more than was ordered", () => {
    const t = buildThreeWay(base({ receipts: [], receiptLines: [], billLines: [{ id: "b1", description: "Cloud GPU Compute Cluster", uom: "each", qty_invoiced: 6, unit_price: 2500 }] }));
    expect(t.lines[0].flags).toEqual(expect.arrayContaining(["not_received", "qty_over_ordered"]));
  });

  it("a PO line missing from the invoice is shown as not invoiced (a partial invoice is normal)", () => {
    const t = buildThreeWay(base({
      poLines: [
        { id: "pl1", line_number: 1, description: "Cloud GPU Compute Cluster", uom: "each", qty_ordered: 4, unit_price: 2500, tolerance_pct: 0.02 },
        { id: "pl2", line_number: 2, description: "Storage Allocation", uom: "each", qty_ordered: 1, unit_price: 2450, tolerance_pct: 0.02 },
      ],
    }));
    expect(t.lines.map((l) => l.flags)).toEqual([[], ["not_invoiced"]]);
    expect(t.lines[1].invoice).toBeNull();
    expect(t.totals.ordered).toBe(12450);
    expect(t.totals.invoiced).toBe(10000);
  });

  it("an invoice line with nothing on the PO to pair with is listed separately", () => {
    const t = buildThreeWay(base({
      billLines: [
        { id: "b1", description: "Cloud GPU Compute Cluster", uom: "each", qty_invoiced: 4, unit_price: 2500 },
        { id: "b2", description: "Emergency courier surcharge", uom: "each", qty_invoiced: 1, unit_price: 180 },
      ],
    }));
    expect(t.unmatchedInvoiceLines).toEqual([{ description: "Emergency courier surcharge", uom: "each", qty: 1, unitPrice: 180, amount: 180 }]);
    expect(t.totals.invoiced).toBe(10180);
  });

  it("pairs lines by the engine's matcher, not by their order", () => {
    const t = buildThreeWay(base({
      poLines: [
        { id: "pl1", line_number: 1, description: "Structural steel coil", uom: "each", qty_ordered: 10, unit_price: 50, tolerance_pct: 0.02 },
        { id: "pl2", line_number: 2, description: "Copper wire spool", uom: "each", qty_ordered: 5, unit_price: 80, tolerance_pct: 0.02 },
      ],
      receipts: [{ id: "r1", receipt_date: "2026-10-05", receiver_name: null, condition: "accepted", final_delivery_indicator: true }],
      receiptLines: [{ goods_receipt_id: "r1", po_line_id: "pl1", qty_received: 10 }, { goods_receipt_id: "r1", po_line_id: "pl2", qty_received: 5 }],
      billLines: [
        { id: "b1", description: "Copper wire spool", uom: "each", qty_invoiced: 5, unit_price: 80 },
        { id: "b2", description: "Structural steel coil", uom: "each", qty_invoiced: 10, unit_price: 50 },
      ],
    }));
    expect(t.lines[0].invoice?.description).toBe("Structural steel coil");
    expect(t.lines[1].invoice?.description).toBe("Copper wire spool");
    expect(t.lines.every((l) => l.flags.length === 0)).toBe(true);
  });

  it("carries the blanket-PO ceiling through", () => {
    expect(buildThreeWay(base({ po: { po_number: "PO-9", status: "open", po_type: "blanket", currency: "USD", max_value_ceiling: 10000 } })).ceiling).toBe(10000);
  });
});
