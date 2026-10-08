import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSql } from "../db/client";
import { assertDestructiveAllowed } from "../db/guard";
import PDFDocument from "pdfkit";

interface DemoItem {
  vendorName: string;
  taxId: string;
  poNumber: string;
  grNumber: string;
  invoiceNumber: string;
  date: string;
  itemDesc: string;
  qty: number;
  price: number;
  hasVariance?: boolean;
  varianceDesc?: string;
  invoicePrice?: number;
}

const DEMO_DATA: DemoItem[] = [
  {
    vendorName: "Acme Cloud Services",
    taxId: "US-94820191",
    poNumber: "PO-2026-1001",
    grNumber: "GR-2026-1001",
    invoiceNumber: "INV-ACS-1001",
    date: "2026-09-10",
    itemDesc: "Cloud GPU Compute Cluster (A100)",
    qty: 4,
    price: 2500.00
  },
  {
    vendorName: "Global Freight Corp",
    taxId: "US-77192842",
    poNumber: "PO-2026-1002",
    grNumber: "GR-2026-1002",
    invoiceNumber: "INV-GFC-1002",
    date: "2026-09-11",
    itemDesc: "Dedicated Fiber Interconnect Service",
    qty: 1,
    price: 8900.50
  },
  {
    vendorName: "Apex Logistics",
    taxId: "US-11223344",
    poNumber: "PO-2026-1003",
    grNumber: "GR-2026-1003",
    invoiceNumber: "INV-APX-1003",
    date: "2026-09-12",
    itemDesc: "International Air Cargo Transport",
    qty: 2,
    price: 3400.00
  },
  {
    vendorName: "Starlight Telecom",
    taxId: "US-66192834",
    poNumber: "PO-2026-1004",
    grNumber: "GR-2026-1004",
    invoiceNumber: "INV-STL-1004",
    date: "2026-09-12",
    itemDesc: "IoT Edge Sensor Array Maintenance",
    qty: 10,
    price: 1420.00
  },
  {
    vendorName: "CyberDyne Systems",
    taxId: "US-88472915",
    poNumber: "PO-2026-1005",
    grNumber: "GR-2026-1005",
    invoiceNumber: "INV-CDS-1005",
    date: "2026-09-13",
    itemDesc: "Neural Engine Hardware Accelerator",
    qty: 2,
    price: 19100.00
  },
  {
    vendorName: "Nexus Hardware Ltd",
    taxId: "US-88192046",
    poNumber: "PO-2026-1006",
    grNumber: "GR-2026-1006",
    invoiceNumber: "INV-NEX-1006",
    date: "2026-09-13",
    itemDesc: "Cloud Edge Hosting Server Rack",
    qty: 1,
    price: 15400.00
  },
  {
    vendorName: "Horizon Energy",
    taxId: "US-99887766",
    poNumber: "PO-2026-1007",
    grNumber: "GR-2026-1007",
    invoiceNumber: "INV-HZN-1007",
    date: "2026-09-14",
    itemDesc: "Industrial Substation Power Unit",
    qty: 1,
    price: 12500.00
  },
  {
    vendorName: "Quantum Compute Inc",
    taxId: "US-55192828",
    poNumber: "PO-2026-1008",
    grNumber: "GR-2026-1008",
    invoiceNumber: "INV-QNT-1008",
    date: "2026-09-14",
    itemDesc: "Quantum Encryption Security Module",
    qty: 3,
    price: 6200.00
  },
  {
    vendorName: "Vertex Materials",
    taxId: "US-33192879",
    poNumber: "PO-2026-1009",
    grNumber: "GR-2026-1009",
    invoiceNumber: "INV-VTX-1009",
    date: "2026-09-15",
    itemDesc: "Bulk Structural Steel Coils",
    qty: 100,
    price: 50.00,
    hasVariance: true,
    invoicePrice: 58.00 // Intentionally 16% price variance to test exception handling!
  },
  {
    vendorName: "Orion Security Corp",
    taxId: "US-44556677",
    poNumber: "PO-2026-1010",
    grNumber: "GR-2026-1010",
    invoiceNumber: "INV-ORN-1010",
    date: "2026-09-15",
    itemDesc: "Enterprise Biometric Access Control",
    qty: 5,
    price: 2100.00
  }
];

function generatePDF(item: DemoItem, pdfPath: string) {
  const doc = new PDFDocument({ margin: 50 });
  const writeStream = fs.createWriteStream(pdfPath);
  doc.pipe(writeStream);

  const unitPrice = item.invoicePrice ?? item.price;
  const total = item.qty * unitPrice;

  // Header
  doc.fontSize(22).fillColor("#1e293b").text(item.vendorName.toUpperCase(), { align: "left" });
  doc.fontSize(10).fillColor("#64748b").text(`Tax ID: ${item.taxId}`);
  doc.moveDown();

  doc.fontSize(26).fillColor("#0f172a").text("INVOICE", { align: "right" });
  doc.fontSize(10).fillColor("#475569").text(`Invoice #: ${item.invoiceNumber}`, { align: "right" });
  doc.text(`Date: ${item.date}`, { align: "right" });
  doc.text(`Purchase Order: ${item.poNumber}`, { align: "right" });
  doc.moveDown(2);

  // Line Items Table Header
  doc.fontSize(11).fillColor("#0f172a").text("Description", 50, 200);
  doc.text("Qty", 320, 200, { width: 50, align: "right" });
  doc.text("Unit Price", 380, 200, { width: 80, align: "right" });
  doc.text("Total", 470, 200, { width: 80, align: "right" });

  doc.moveTo(50, 215).lineTo(550, 215).strokeColor("#cbd5e1").stroke();

  // Line Item Row
  doc.fontSize(10).fillColor("#334155").text(item.itemDesc, 50, 230, { width: 260 });
  doc.text(item.qty.toString(), 320, 230, { width: 50, align: "right" });
  doc.text(`$${unitPrice.toFixed(2)}`, 380, 230, { width: 80, align: "right" });
  doc.text(`$${total.toFixed(2)}`, 470, 230, { width: 80, align: "right" });

  doc.moveTo(50, 260).lineTo(550, 260).strokeColor("#e2e8f0").stroke();

  // Total
  doc.fontSize(12).fillColor("#0f172a").text(`Total Amount Due: $${total.toFixed(2)}`, 350, 280, { align: "right" });

  if (item.hasVariance) {
    doc.moveDown(3);
    doc.fontSize(9).fillColor("#dc2626").text(`* Note: Unit price updated per standard rate adjustment.`, 50, 320);
  }

  doc.end();
}

function generateTxt(item: DemoItem, txtPath: string) {
  const unitPrice = item.invoicePrice ?? item.price;
  const total = item.qty * unitPrice;

  const content = `INVOICE
Vendor: ${item.vendorName}
Tax ID: ${item.taxId}
Invoice Date: ${item.date}
Invoice Number: ${item.invoiceNumber}
Purchase Order: ${item.poNumber}

Line Items:
1. ${item.itemDesc}
   Qty: ${item.qty}
   Unit Price: $${unitPrice.toFixed(2)}

Total Amount Due: $${total.toFixed(2)}
`;
  fs.writeFileSync(txtPath, content, "utf8");
}

async function main() {
  assertDestructiveAllowed("scripts/setup-clean-demo.ts");
  const sql = getSql();
  console.log("🧹 Clearing all existing invoice data from database...");

  // Delete in reverse dependency order
  await sql`DELETE FROM reviews`;
  await sql`DELETE FROM payment_applications`;
  await sql`DELETE FROM payments`;
  await sql`DELETE FROM pbc_evidence_files`;
  await sql`DELETE FROM pbc_requests`;
  await sql`DELETE FROM decisions`;
  await sql`DELETE FROM vendor_bill_lines`;
  await sql`DELETE FROM vendor_bills`;
  await sql`DELETE FROM journal_entry_lines`;
  await sql`DELETE FROM journal_entries`;
  await sql`DELETE FROM goods_receipt_lines`;
  await sql`DELETE FROM goods_receipts`;
  await sql`DELETE FROM purchase_order_lines`;
  await sql`DELETE FROM purchase_orders`;
  await sql`DELETE FROM vendor_corrections`;
  await sql`DELETE FROM vendor_bank_change_reviews`;
  await sql`DELETE FROM vendors`;

  console.log("✅ Database cleared cleanly.");

  const outputDir = "D:\\AO_Hackathon\\demo-invoices";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("🌱 Seeding 10 Vendors, POs, and Goods Receipts...");

  const expenseAccount = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
  const expenseAccountId = expenseAccount[0]?.id ?? null;

  for (const item of DEMO_DATA) {
    const vendorId = crypto.randomUUID();
    const poId = crypto.randomUUID();
    const poLineId = crypto.randomUUID();
    const grId = crypto.randomUUID();

    // 1. Insert Vendor
    await sql`
      INSERT INTO vendors (id, name, trust_tier, tax_id, w9_on_file, payment_terms_code)
      VALUES (${vendorId}, ${item.vendorName}, 'trusted', ${item.taxId}, true, 'Net 30')
    `;

    // 2. Insert PO
    await sql`
      INSERT INTO purchase_orders (id, po_number, vendor_id, buyer_name, order_date, status, po_type, currency, exchange_rate)
      VALUES (${poId}, ${item.poNumber}, ${vendorId}, 'J. Ramirez', ${item.date}, 'open', 'standard', 'USD', 1.0)
    `;

    // 3. Insert PO Line
    await sql`
      INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id)
      VALUES (${poLineId}, ${poId}, 1, ${item.itemDesc}, 'each', ${item.qty}, ${item.price}, ${expenseAccountId})
    `;

    // 4. Insert Goods Receipt
    await sql`
      INSERT INTO goods_receipts (id, po_id, receipt_date, receiver_name, condition)
      VALUES (${grId}, ${poId}, ${item.date}, 'Warehouse Staff', 'accepted')
    `;

    // 5. Insert Goods Receipt Line
    await sql`
      INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received)
      VALUES (${crypto.randomUUID()}, ${grId}, ${poLineId}, ${item.qty})
    `;

    // 6. Generate PDF and TXT in D:\AO_Hackathon\demo-invoices
    const pdfFilename = `${item.poNumber}_${item.vendorName.replace(/\s+/g, "_")}.pdf`;
    const txtFilename = `${item.poNumber}_${item.vendorName.replace(/\s+/g, "_")}.txt`;

    generatePDF(item, path.join(outputDir, pdfFilename));
    generateTxt(item, path.join(outputDir, txtFilename));

    console.log(` Generated ${pdfFilename} & ${txtFilename} for PO ${item.poNumber}`);
  }

  console.log(`\n🎉 Success! Database reset complete. 10 invoices created in: ${outputDir}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error setting up demo dataset:", err);
  process.exit(1);
});
