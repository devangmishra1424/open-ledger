/** Shows what the layout rules read from one test document next to its answer key (development aid).
 *  npx tsx eval/documents/debug.ts us_invoice digital.pdf [--rows] */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowsFromReading } from "@/lib/documents/layout";
import { readInvoiceRules } from "@/lib/documents/invoice-rules";

const [layout, form] = process.argv.slice(2);
const root = join(process.cwd(), "eval", "documents");
const bytes = readFileSync(join(root, "invoices", layout, form));
const reading = JSON.parse(readFileSync(join(root, "readings", `${createHash("sha256").update(bytes).digest("hex")}.json`), "utf8"));
const rows = rowsFromReading(reading);
if (process.argv.includes("--rows")) rows.forEach((r) => console.log(String(r.index).padStart(3), `p${r.page}`, r.cells.map((c) => `[${c.x0}-${c.x1}] ${c.text}`).join("  ")));
const got = readInvoiceRules(rows);
const truth = JSON.parse(readFileSync(join(root, "invoices", layout, "truth.json"), "utf8"));
for (const k of ["vendor_name", "invoice_number", "invoice_date", "po_reference", "currency", "subtotal", "tax", "total"]) {
  const ok = JSON.stringify((got as any)[k]) === JSON.stringify(truth[k]) ? "  " : "XX";
  console.log(ok, k.padEnd(15), JSON.stringify((got as any)[k]), " want", JSON.stringify(truth[k]));
}
console.log("lines got", got.line_items.length, "want", truth.line_items.length);
got.line_items.forEach((l, i) => console.log("   ", l.quantity, l.unit_price, l.amount, "|", l.description, l.problem ? `  !! ${l.problem}` : "", "| want", JSON.stringify(truth.line_items[i])));
console.log("tax_lines", JSON.stringify(got.tax_lines), "charges", JSON.stringify(got.other_charges), "round", got.round_off, "disc", got.discount);
console.log("problems", got.problems);
