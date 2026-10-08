import fs from 'fs';
import path from 'path';
import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { assertDestructiveAllowed } from "@/db/guard";
import PDFDocument from 'pdfkit';

const outputDir = "D:\\AO_Hackathon\\demo-invoices";

async function main() {
  assertDestructiveAllowed("scripts/generate_demo_pdfs.ts");
  const sql = getSql();

  console.log("Clearing existing invoices, POs, and GRs...");
  
  // Clear invoices and PBCs first (children of POs)
  await sql`DELETE FROM vendor_bill_lines`;
  await sql`DELETE FROM vendor_bills`;
  await sql`DELETE FROM pbc_requests`;
  
  // Clear GRs and POs
  await sql`DELETE FROM goods_receipt_lines`;
  await sql`DELETE FROM goods_receipts`;
  await sql`DELETE FROM purchase_order_lines`;
  await sql`DELETE FROM purchase_orders`;

  console.log("Resolving Chart of Accounts...");
  const apAccountRows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '2000'`;
  const expenseAccountRows = await sql`SELECT id FROM chart_of_accounts WHERE account_number = '6000'`;
  const apAccountId = apAccountRows[0].id;
  const expenseAccountId = expenseAccountRows[0].id;

  const vendorRows = await sql`SELECT id, name FROM vendors LIMIT 10`;
  const vendors = vendorRows.map(r => ({ id: r.id, name: r.name }));
  if (vendors.length === 0) throw new Error("No vendors found");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Generating 10 new distinct POs, GRs, and matching PDF invoices...");
  // Create 10 invoices worth of POs and GRs
  for (let i = 1; i <= 10; i++) {
    const vendor = vendors[i % vendors.length];
    const poId = randomUUID();
    const poNumber = `PO-2026-${5000 + i}`;
    const amount = 1000 + i * 500;
    
    // Create PO
    await sql`
      INSERT INTO purchase_orders (id, po_number, vendor_id, buyer_name, order_date, status, po_type, currency, exchange_rate)
      VALUES (${poId}, ${poNumber}, ${vendor.id}, 'Demo Buyer', CURRENT_DATE - INTERVAL '15 days', 'open', 'standard', 'USD', 1.0)
    `;

    const poLineId = randomUUID();
    await sql`
      INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price, gl_account_id)
      VALUES (${poLineId}, ${poId}, 1, 'Demo Service ' || ${i}, 'each', 1, ${amount}, ${expenseAccountId})
    `;

    // Create GR
    const grId = randomUUID();
    await sql`
      INSERT INTO goods_receipts (id, po_id, receipt_date, receiver_name, condition, final_delivery_indicator)
      VALUES (${grId}, ${poId}, CURRENT_DATE - INTERVAL '5 days', 'Warehouse Manager', 'accepted', true)
    `;

    await sql`
      INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received)
      VALUES (${randomUUID()}, ${grId}, ${poLineId}, 1)
    `;

    // Generate PDF
    const invoiceNumber = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
    const pdfPath = path.join(outputDir, `Invoice_${vendor.name.replace(/[^a-zA-Z0-9]/g, '_')}_${invoiceNumber}.pdf`);
    
    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(fs.createWriteStream(pdfPath));
    
    doc.fontSize(25).text('INVOICE', { align: 'right' });
    doc.moveDown();
    doc.fontSize(12);
    
    doc.text(`Vendor: ${vendor.name}`);
    doc.text(`Invoice Date: ${new Date().toISOString().slice(0, 10)}`);
    doc.text(`Invoice Number: ${invoiceNumber}`);
    doc.text(`Purchase Order: ${poNumber}`);
    doc.moveDown(2);
    
    doc.text('Line Items:', { underline: true });
    doc.moveDown();
    
    doc.text(`1. Demo Service ${i}`);
    doc.text(`   Qty: 1`);
    doc.text(`   Unit Price: $${amount.toFixed(2)}`);
    doc.moveDown();
    
    const subtotal = amount;
    const tax = amount * 0.05;
    const total = subtotal + tax;
    
    doc.text(`Subtotal: $${subtotal.toFixed(2)}`, { align: 'right' });
    doc.text(`Tax (5%): $${tax.toFixed(2)}`, { align: 'right' });
    doc.text(`Total Amount Due: $${total.toFixed(2)}`, { align: 'right', stroke: true });
    
    doc.end();
    console.log(`Generated ${pdfPath} (PO: ${poNumber})`);
  }
  
  await sql.end();
  console.log("DB reset and PDFs generated successfully!");
}

main().catch(console.error);
