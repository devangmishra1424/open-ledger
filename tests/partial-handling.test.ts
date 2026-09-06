import { describe, it, expect } from "vitest";
import { computePoLineFulfillment } from "@/lib/matching/partial-handling";

describe("computePoLineFulfillment (spec §1.6 Scenario A: Partial Shipment)", () => {
  it("PO 100, GRN 70 received, invoice bills 70 -> matched 70, open 30, no excess, PO line partial", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 100,
      qtyReceived: 70,
      qtyInvoicedPrior: 0,
      qtyInvoicedCurrent: 70,
    });
    expect(r.matchedQty).toBe(70);
    expect(r.openQty).toBe(30);
    expect(r.excessQty).toBe(0);
    expect(r.qtyInvoicedToDate).toBe(70);
    expect(r.poLineStatus).toBe("partial");
    expect(r.exceptionCode).toBeUndefined();
  });
});

describe("computePoLineFulfillment (spec §1.6 Scenario B: Split Invoice)", () => {
  it("invoice 1 of 2: qty=60 against a 100-unit line, fully received -> partial match, open=40", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 100,
      qtyReceived: 100,
      qtyInvoicedPrior: 0,
      qtyInvoicedCurrent: 60,
    });
    expect(r.matchedQty).toBe(60);
    expect(r.openQty).toBe(40);
    expect(r.excessQty).toBe(0);
    expect(r.qtyInvoicedToDate).toBe(60);
    expect(r.poLineStatus).toBe("partial");
  });

  it("invoice 2 of 2: qty=40, prior invoiced=60 -> full match, running total 100, PO line closed", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 100,
      qtyReceived: 100,
      qtyInvoicedPrior: 60,
      qtyInvoicedCurrent: 40,
    });
    expect(r.matchedQty).toBe(40);
    expect(r.openQty).toBe(0);
    expect(r.excessQty).toBe(0);
    expect(r.qtyInvoicedToDate).toBe(100);
    expect(r.poLineStatus).toBe("closed");
    expect(r.exceptionCode).toBeUndefined();
  });
});

describe("computePoLineFulfillment (spec §1.6 Scenario C: Over-Invoice)", () => {
  it("invoice 120, GRN 100, PO 150 -> matched capped at 100 (what was received), excess=20, EXC-QTY_VAR raised", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 150,
      qtyReceived: 100,
      qtyInvoicedPrior: 0,
      qtyInvoicedCurrent: 120,
    });
    expect(r.matchedQty).toBe(100);
    expect(r.excessQty).toBe(20);
    expect(r.qtyInvoicedToDate).toBe(100);
    // 50 units of the PO line are still open for future receipt/invoicing, distinct from the
    // 20-unit excess that gets blocked outright.
    expect(r.openQty).toBe(50);
    expect(r.poLineStatus).toBe("partial");
    expect(r.exceptionCode).toBe("EXC-QTY_VAR");
  });
});

describe("computePoLineFulfillment (edge cases)", () => {
  it("first-ever invoice against a line (zero prior invoiced, zero received) -> nothing payable, all of it excess", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 50,
      qtyReceived: 0,
      qtyInvoicedPrior: 0,
      qtyInvoicedCurrent: 10,
    });
    expect(r.matchedQty).toBe(0);
    expect(r.excessQty).toBe(10);
    expect(r.qtyInvoicedToDate).toBe(0);
    expect(r.openQty).toBe(50);
    expect(r.poLineStatus).toBe("open");
    expect(r.exceptionCode).toBe("EXC-QTY_VAR");
  });

  it("invoice qty exactly equals what's available to invoice -> exact boundary, no excess, line closes exactly", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 100,
      qtyReceived: 100,
      qtyInvoicedPrior: 40,
      // available = qtyReceived(100) - qtyInvoicedPrior(40) = 60, and current is exactly 60
      qtyInvoicedCurrent: 60,
    });
    expect(r.matchedQty).toBe(60);
    expect(r.excessQty).toBe(0);
    expect(r.qtyInvoicedToDate).toBe(100);
    expect(r.openQty).toBe(0);
    expect(r.poLineStatus).toBe("closed");
    expect(r.exceptionCode).toBeUndefined();
  });

  it("prior invoices already consumed everything received -> a new invoice against this line is entirely excess, not negative", () => {
    const r = computePoLineFulfillment({
      poLineId: "po-line-1",
      qtyOrdered: 100,
      qtyReceived: 50,
      qtyInvoicedPrior: 50,
      qtyInvoicedCurrent: 5,
    });
    expect(r.matchedQty).toBe(0);
    expect(r.excessQty).toBe(5);
    expect(r.qtyInvoicedToDate).toBe(50);
    expect(r.openQty).toBe(50);
    expect(r.poLineStatus).toBe("partial");
    expect(r.exceptionCode).toBe("EXC-QTY_VAR");
  });
});
