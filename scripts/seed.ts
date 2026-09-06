import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { runPipeline } from "@/lib/pipeline/orchestrator";

/**
 * Real demo dataset for Open Ledger — not fixtures a test cleans up, rows meant to stay in the
 * live DB so the actual frontend has something real to render. Every bill below is run through
 * the real `runPipeline()` (real OpenAI/TensorMux calls for investigate/verify where reached,
 * real hash chain, real journal postings on auto_approve) — nothing here fabricates a decision
 * or a hash directly. Safe to re-run: bails out if vendor_bills already has rows, rather than
 * silently duplicating a second demo set on top of a real one.
 */

const today = new Date().toISOString().slice(0, 10);
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seedInvoices(): Promise<void> {
  const sql = getSql();

  const existing = await sql`SELECT COUNT(*)::int as n FROM vendor_bills`;
  if (existing[0].n > 0) {
    console.log(`vendor_bills already has ${existing[0].n} row(s) — skipping invoice seed. Delete rows manually first to reseed.`);
    return;
  }

  console.log("Resolving chart of accounts + accounting period (reusing what's already on file)...");
  async function requireAccount(accountNumber: string): Promise<string> {
    const rows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = ${accountNumber}`;
    if (rows.length === 0) throw new Error(`seed: chart_of_accounts is missing account_number '${accountNumber}' — expected the real COA to already be loaded`);
    return rows[0].id;
  }
  const apAccountId = await requireAccount("2000");
  const expenseAccountId = await requireAccount("6000");

  const periodRows = await sql`SELECT id FROM accounting_periods WHERE start_date <= ${today} AND end_date >= ${today} AND status = 'open'`;
  if (periodRows.length === 0) throw new Error(`seed: no open accounting_periods row covers today (${today}) — expected one to already be loaded`);

  console.log("Seeding vendors...");
  const vendors = {
    acme: randomUUID(),
    cyberdyne: randomUUID(),
    globalLogistics: randomUUID(),
    nexus: randomUUID(),
    starlight: randomUUID(),
    quantumFreight: randomUUID(),
    vertex: randomUUID(),
  };
  await sql`
    INSERT INTO vendors (id, name, bank_account_last4, bank_account_changed_at, trust_tier, tax_id, w9_on_file, payment_terms_code) VALUES
      (${vendors.acme}, 'Acme Corp', '4471', NULL, 'trusted', 'US-94820193', true, 'Net 30'),
      (${vendors.cyberdyne}, 'CyberDyne Systems', '5582', NULL, 'trusted', 'US-88472910', true, 'Net 15'),
      (${vendors.globalLogistics}, 'Global Logistics Hub', '9012', ${daysAgo(10)}, 'new', 'US-77192844', true, 'Net 30'),
      (${vendors.nexus}, 'Nexus Dynamics', '3321', NULL, 'new', 'US-88192043', true, 'Net 30'),
      (${vendors.starlight}, 'Starlight Telemetry', '7743', NULL, 'trusted', 'US-66192831', true, 'Net 45'),
      (${vendors.quantumFreight}, 'Quantum Freight', '2290', NULL, 'new', 'US-55192822', false, 'Net 30'),
      (${vendors.vertex}, 'Vertex Materials', '6654', NULL, 'trusted', 'US-33192877', true, 'Net 30')
  `;

  console.log("Seeding purchase orders + lines...");
  const pos = {
    acme: randomUUID(),
    cyberdyne: randomUUID(),
    globalLogistics: randomUUID(),
    nexus: randomUUID(),
    starlight: randomUUID(),
    vertex: randomUUID(),
  };
  await sql`
    INSERT INTO purchase_orders (id, po_number, vendor_id, buyer_name, order_date, status, po_type, max_value_ceiling, currency, exchange_rate) VALUES
      (${pos.acme}, 'PO-2024-1138', ${vendors.acme}, 'J. Ramirez', ${daysAgo(20)}, 'open', 'standard', NULL, 'USD', 1.0),
      (${pos.cyberdyne}, 'PO-2024-1142', ${vendors.cyberdyne}, 'J. Ramirez', ${daysAgo(18)}, 'open', 'standard', NULL, 'USD', 1.0),
      (${pos.globalLogistics}, 'PO-2024-1145', ${vendors.globalLogistics}, 'A. Chen', ${daysAgo(15)}, 'open', 'standard', NULL, 'USD', 1.0),
      (${pos.nexus}, 'PO-2024-1160', ${vendors.nexus}, 'A. Chen', ${daysAgo(12)}, 'open', 'standard', NULL, 'USD', 1.0),
      (${pos.starlight}, 'PO-2024-1150', ${vendors.starlight}, 'M. Osei', ${daysAgo(14)}, 'open', 'standard', NULL, 'USD', 1.0),
      (${pos.vertex}, 'PO-2024-1170', ${vendors.vertex}, 'M. Osei', ${daysAgo(40)}, 'open', 'blanket', 10000, 'USD', 1.0)
  `;

  const poLines = {
    acme1: randomUUID(), acme2: randomUUID(),
    cyberdyne1: randomUUID(),
    globalLogistics1: randomUUID(),
    nexus1: randomUUID(),
    starlight1: randomUUID(),
    vertex1: randomUUID(),
  };
  await sql`
    INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id) VALUES
      (${poLines.acme1}, ${pos.acme}, 1, 'Cloud GPU Compute Cluster (A100)', 'each', 4, 2500.00, ${expenseAccountId}),
      (${poLines.acme2}, ${pos.acme}, 2, 'High-Throughput Storage Allocation', 'each', 1, 2450.00, ${expenseAccountId}),
      (${poLines.cyberdyne1}, ${pos.cyberdyne}, 1, 'Neural Engine Hardware Accelerator', 'each', 2, 19100.00, ${expenseAccountId}),
      (${poLines.globalLogistics1}, ${pos.globalLogistics}, 1, 'Dedicated Fiber Interconnect Service', 'each', 1, 8900.50, ${expenseAccountId}),
      (${poLines.nexus1}, ${pos.nexus}, 1, 'Cloud Edge Hosting Cluster', 'each', 1, 15400.00, ${expenseAccountId}),
      (${poLines.starlight1}, ${pos.starlight}, 1, 'IoT Edge Sensor Array Maintenance', 'each', 10, 1420.00, ${expenseAccountId}),
      (${poLines.vertex1}, ${pos.vertex}, 1, 'Bulk Structural Steel Coil', 'each', 100, 50.00, ${expenseAccountId})
  `;

  console.log("Seeding goods receipts...");
  const grAcme = randomUUID(), grCyberdyne = randomUUID(), grNexus = randomUUID(), grStarlight = randomUUID(), grVertex = randomUUID();
  await sql`
    INSERT INTO goods_receipts (id, po_id, receipt_date, receiver_name, condition, final_delivery_indicator) VALUES
      (${grAcme}, ${pos.acme}, ${daysAgo(6)}, 'W. Novak', 'accepted', true),
      (${grCyberdyne}, ${pos.cyberdyne}, ${daysAgo(5)}, 'W. Novak', 'accepted', true),
      (${grNexus}, ${pos.nexus}, ${daysAgo(4)}, 'W. Novak', 'accepted', true),
      (${grStarlight}, ${pos.starlight}, ${daysAgo(7)}, 'W. Novak', 'accepted', true),
      (${grVertex}, ${pos.vertex}, ${daysAgo(10)}, 'W. Novak', 'accepted', true)
  `;
  await sql`
    INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES
      (${randomUUID()}, ${grAcme}, ${poLines.acme1}, 4),
      (${randomUUID()}, ${grAcme}, ${poLines.acme2}, 1),
      (${randomUUID()}, ${grCyberdyne}, ${poLines.cyberdyne1}, 2),
      (${randomUUID()}, ${grNexus}, ${poLines.nexus1}, 1),
      (${randomUUID()}, ${grStarlight}, ${poLines.starlight1}, 10),
      (${randomUUID()}, ${grVertex}, ${poLines.vertex1}, 250)
  `;

  console.log("Seeding vendor bills + lines...");

  async function makeBill(params: {
    id: string; vendorId: string; poId: string | null; invoiceNumber: string; invoiceDate: string;
    dueDate: string; subtotal: number; taxTotal?: number; totalAmount: number;
    invoiceType?: "standard" | "credit_memo"; relatedInvoiceId?: string;
    lines: Array<{ description: string; qty: number; unitPrice: number; uom?: string; poLineId?: string }>;
  }) {
    await sql`
      INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, due_date, currency, exchange_rate,
        subtotal, tax_total, total_amount, ap_account_id, status, invoice_type, related_invoice_id, received_at)
      VALUES (${params.id}, ${params.vendorId}, ${params.poId}, ${params.invoiceNumber}, ${params.invoiceDate}, ${params.dueDate},
        'USD', 1.0, ${params.subtotal}, ${params.taxTotal ?? 0}, ${params.totalAmount}, ${apAccountId}, 'processing',
        ${params.invoiceType ?? "standard"}, ${params.relatedInvoiceId ?? null}, ${params.invoiceDate})
    `;
    for (const line of params.lines) {
      await sql`
        INSERT INTO vendor_bill_lines (id, vendor_bill_id, po_line_id, description, qty_invoiced, unit_price, uom, gl_account_id)
        VALUES (${randomUUID()}, ${params.id}, ${line.poLineId ?? null}, ${line.description}, ${line.qty}, ${line.unitPrice}, ${line.uom ?? "each"}, ${expenseAccountId})
      `;
    }
  }

  const billAcmeClean = randomUUID();
  await makeBill({
    id: billAcmeClean, vendorId: vendors.acme, poId: pos.acme, invoiceNumber: "INV-2024-0847",
    invoiceDate: daysAgo(3), dueDate: daysAgo(-27), subtotal: 12450.0, totalAmount: 12450.0,
    lines: [
      { description: "Cloud GPU Compute Cluster (A100)", qty: 4, unitPrice: 2500.0, poLineId: poLines.acme1 },
      { description: "High-Throughput Storage Allocation", qty: 1, unitPrice: 2450.0, poLineId: poLines.acme2 },
    ],
  });

  const billCyberdyneClean = randomUUID();
  await makeBill({
    id: billCyberdyneClean, vendorId: vendors.cyberdyne, poId: pos.cyberdyne, invoiceNumber: "INV-2024-0848",
    invoiceDate: daysAgo(2), dueDate: daysAgo(-13), subtotal: 38200.0, totalAmount: 38200.0,
    lines: [{ description: "Neural Engine Hardware Accelerator", qty: 2, unitPrice: 19100.0, poLineId: poLines.cyberdyne1 }],
  });

  const billFraud = randomUUID();
  await makeBill({
    id: billFraud, vendorId: vendors.globalLogistics, poId: pos.globalLogistics, invoiceNumber: "INV-2024-0849",
    invoiceDate: daysAgo(1), dueDate: daysAgo(-29), subtotal: 8900.5, totalAmount: 8900.5,
    lines: [{ description: "Dedicated Fiber Interconnect Service", qty: 1, unitPrice: 8900.5, poLineId: poLines.globalLogistics1 }],
  });

  const billPriceVar = randomUUID();
  await makeBill({
    id: billPriceVar, vendorId: vendors.nexus, poId: pos.nexus, invoiceNumber: "INV-2024-0850",
    invoiceDate: today, dueDate: daysAgo(-45), subtotal: 17710.0, totalAmount: 17710.0,
    lines: [{ description: "Cloud Edge Hosting Cluster", qty: 1, unitPrice: 17710.0, poLineId: poLines.nexus1 }],
  });

  const billUomMismatch = randomUUID();
  await makeBill({
    id: billUomMismatch, vendorId: vendors.starlight, poId: pos.starlight, invoiceNumber: "INV-2024-0851",
    invoiceDate: daysAgo(1), dueDate: daysAgo(-44), subtotal: 14200.0, totalAmount: 14200.0,
    lines: [{ description: "IoT Edge Sensor Array Maintenance", qty: 1, unitPrice: 14200.0, uom: "box" }],
  });

  const billNonPo = randomUUID();
  await makeBill({
    id: billNonPo, vendorId: vendors.quantumFreight, poId: null, invoiceNumber: "INV-2024-0852",
    invoiceDate: today, dueDate: daysAgo(-30), subtotal: 6500.0, totalAmount: 6500.0,
    lines: [{ description: "Emergency Freight Consulting Engagement", qty: 1, unitPrice: 6500.0 }],
  });

  const billBlanketExceeded = randomUUID();
  await makeBill({
    id: billBlanketExceeded, vendorId: vendors.vertex, poId: pos.vertex, invoiceNumber: "INV-2024-0853",
    invoiceDate: today, dueDate: daysAgo(-30), subtotal: 12500.0, totalAmount: 12500.0,
    lines: [{ description: "Bulk Structural Steel Coil", qty: 250, unitPrice: 50.0, poLineId: poLines.vertex1 }],
  });

  const billCreditMemo = randomUUID();
  await makeBill({
    id: billCreditMemo, vendorId: vendors.acme, poId: null, invoiceNumber: "INV-2024-0847-CM",
    invoiceDate: today, dueDate: today, subtotal: 2000.0, totalAmount: 2000.0,
    invoiceType: "credit_memo", relatedInvoiceId: billAcmeClean,
    lines: [{ description: "Partial credit — over-billed compute hours", qty: 1, unitPrice: 2000.0 }],
  });

  const bills = [
    ["Acme Corp (clean match)", billAcmeClean],
    ["CyberDyne Systems (clean match)", billCyberdyneClean],
    ["Global Logistics Hub (bank-change fraud gate)", billFraud],
    ["Nexus Dynamics (price variance)", billPriceVar],
    ["Starlight Telemetry (UOM mismatch)", billUomMismatch],
    ["Quantum Freight (non-PO)", billNonPo],
    ["Vertex Materials (blanket PO exceeded)", billBlanketExceeded],
    ["Acme Corp (credit memo)", billCreditMemo],
  ] as const;

  console.log(`\nRunning ${bills.length} invoices through the real pipeline (real LLM calls where reached)...`);
  for (const [label, id] of bills) {
    process.stdout.write(`  - ${label} ... `);
    try {
      await runPipeline(id);
      const row = (await sql`SELECT status FROM vendor_bills WHERE id = ${id}`)[0];
      console.log(`done -> status: ${row.status}`);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\nInvoice seed complete.");
}

/**
 * Independently guarded (not gated by seedInvoices' own bail-out) so re-running this script
 * after invoices already exist still fills in PBC requests on a fresh DB, or vice versa.
 * Looks bills up by invoice_number from the DB rather than closing over seedInvoices' local
 * ids, since either function may have been skipped.
 */
async function seedPbcRequests(): Promise<void> {
  const sql = getSql();

  const existing = await sql`SELECT COUNT(*)::int as n FROM pbc_requests`;
  if (existing[0].n > 0) {
    console.log(`pbc_requests already has ${existing[0].n} row(s) — skipping PBC seed.`);
    return;
  }

  async function billId(invoiceNumber: string): Promise<string | undefined> {
    const rows = await sql`SELECT id FROM vendor_bills WHERE invoice_number = ${invoiceNumber}`;
    return rows[0]?.id;
  }

  const cloudBundle = [await billId("INV-2024-0847"), await billId("INV-2024-0848")].filter((x): x is string => !!x);
  const fraudBundle = [await billId("INV-2024-0849")].filter((x): x is string => !!x);
  const highValueBundle = [await billId("INV-2024-0850"), await billId("INV-2024-0853")].filter((x): x is string => !!x);

  if (cloudBundle.length === 0 && fraudBundle.length === 0 && highValueBundle.length === 0) {
    console.log("No seeded invoices found to link PBC requests against — skipping PBC seed (run invoice seed first).");
    return;
  }

  console.log("Seeding PBC (Provided-By-Client) audit requests...");
  await sql`
    INSERT INTO pbc_requests (id, item_type, description, due_date, owner_name, status, linked_invoice_ids, created_at) VALUES
      (${randomUUID()}, 'invoice_bundle', 'Q3 Cloud Infrastructure & Capital Asset Vendor Invoices Sample',
        ${daysAgo(-14)}, 'PwC Lead Auditor (E. Vance)', 'submitted', ${cloudBundle.join(",")}, ${daysAgo(5)}),
      (${randomUUID()}, 'tie_out_check', 'Vendor Wire Route Alterations & Anti-Fraud Whitelist Audit',
        ${daysAgo(-7)}, 'SOX Compliance Team', 'open', ${fraudBundle.join(",")}, ${daysAgo(2)}),
      (${randomUUID()}, 'ap_aging', 'High-Value Disbursements & Blanket PO Overage Review',
        ${daysAgo(-10)}, 'Internal Audit Committee', 'assembled', ${highValueBundle.join(",")}, ${daysAgo(3)})
  `;
  console.log("PBC seed complete.");
}

async function main() {
  await seedInvoices();
  await seedPbcRequests();
  await getSql().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
