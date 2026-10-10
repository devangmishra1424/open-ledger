import PDFDocument from "pdfkit";

/** A real PDF (a text layer, like an exported invoice) built in memory, as a data URL the way the frontend sends an upload. */
export async function makePdfDataUrl(draw: (doc: PDFKit.PDFDocument) => void): Promise<string> {
  const doc = new PDFDocument({ margin: 50 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  draw(doc);
  doc.end();
  return `data:application/pdf;base64,${(await done).toString("base64")}`;
}

/** A table-style invoice: header row, one row per item, totals with no colons: the layout most exported invoices have. */
export function drawTableInvoice(doc: PDFKit.PDFDocument, o: { vendor?: string; number?: string; po?: string | null; date?: string } = {}) {
  const x = [50, 280, 340, 420, 490];
  doc.fontSize(18).text(o.vendor ?? "Northwind Parts Ltd.", 50, 50);
  doc.fontSize(10).text("12 Market Road, Pune", 50, 75);
  doc.fontSize(16).text("INVOICE", 400, 50);
  doc.fontSize(10).text(`Invoice No: ${o.number ?? "NW-4471"}`, 400, 75).text(`Date: ${o.date ?? "2026-10-09"}`, 400, 90);
  if (o.po !== null) doc.text(`PO Number: ${o.po ?? "PO-2026-7001"}`, 400, 105);
  const y = 160;
  ["Description", "Qty", "Unit Price", "Amount"].forEach((h, i) => doc.text(h, x[i], y));
  const rows = [
    ["Industrial Bearing Set", "12", "$145.00", "$1,740.00"],
    ["Maintenance Kit", "4", "$62.50", "$250.00"],
    ["Zinc Plated Bolt M8x40", "200", "$0.75", "$150.00"],
  ];
  rows.forEach((r, k) => r.forEach((c, i) => doc.text(c, x[i], y + 25 + k * 20)));
  const yt = y + 25 + rows.length * 20 + 20;
  doc.text("Subtotal", 340, yt).text("$2,140.00", 490, yt);
  doc.text("Tax (8%)", 340, yt + 18).text("$171.20", 490, yt + 18);
  doc.text("Total", 340, yt + 36).text("$2,311.20", 490, yt + 36);
}
