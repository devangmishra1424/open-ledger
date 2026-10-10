import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { createBill } from "@/lib/bills";
import { postBillApproval } from "@/lib/ledger/journal";

/**
 * Money is stored exactly. With REAL (4-byte float) columns an amount like 16,777,217.03 came back
 * as 16,777,216, and a ledger entry for it could not balance to the cent.
 */
const sql = getSql();

describe("money columns are exact", () => {
  it("stores and returns a large amount to the cent, as a JS number", async () => {
    const created = await createBill({
      vendorName: "Precision Co " + randomUUID().slice(0, 5),
      lines: [{ description: "Turbine", quantity: 1, unitPrice: 16_777_217.03 }],
      strictTotals: true,
    });
    const [bill] = await sql`SELECT subtotal, total_amount FROM vendor_bills WHERE id = ${created.billId}`;
    expect(typeof bill.total_amount).toBe("number");
    expect(bill.total_amount).toBe(16_777_217.03);
    expect(bill.subtotal).toBe(16_777_217.03);
  });

  it("a ledger entry for that amount balances exactly", async () => {
    const created = await createBill({
      vendorName: "Precision Co " + randomUUID().slice(0, 5),
      lines: [{ description: "Turbine", quantity: 3, unitPrice: 4_333_333.33 }],
      tax: 1_299_999.99,
      strictTotals: true,
    });
    const posted = await postBillApproval(created.billId);
    const lines = await sql`SELECT debit_amount, credit_amount FROM journal_entry_lines WHERE entry_id = ${posted.journalEntryId}`;
    const debits = lines.reduce((s: number, l: any) => s + l.debit_amount, 0);
    const credits = lines.reduce((s: number, l: any) => s + l.credit_amount, 0);
    expect(Math.round(debits * 100)).toBe(Math.round(credits * 100));
    expect(Math.round(credits * 100)).toBe(Math.round((3 * 4_333_333.33 + 1_299_999.99) * 100));
  });

  it("aggregates come back as numbers too (SUM over NUMERIC would otherwise be a string)", async () => {
    const [{ total }] = await sql`SELECT COALESCE(SUM(total_amount), 0) AS total FROM vendor_bills`;
    expect(typeof total).toBe("number");
  });

  it("only model confidence is still a float", async () => {
    const cols = await sql`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type = 'real'`;
    expect(cols.map((c: any) => `${c.table_name}.${c.column_name}`).sort()).toEqual(["app_settings.auto_approval_confidence", "decisions.confidence"]);
  });
});
