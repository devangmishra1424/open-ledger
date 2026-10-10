/**
 * Extraction evaluation: how often does the extractor read an invoice WRONG and still sound sure?
 *
 *   npm run eval                 deterministic only (no model, no cost, fully reproducible)
 *   npm run eval -- --llm        also let the LLM fallback read what the template cannot (uses quota)
 *   npm run eval -- --n=400 --seed=7
 *
 * A seeded generator writes invoices in several layouts with known ground truth, then damages some
 * of them the way real documents get damaged: a total that does not add up, a missing date, an OCR
 * digit swap (O for 0), an ambiguous 03/04/2026 date, a layout the parser has never seen. Each
 * damaged class has a right behaviour: it must come back below the 0.85 confidence bar so a person
 * sees it (the pipeline raises EXC-LAYOUT at 85%). Two further classes are NOT damage but ordinary
 * variation the parser must read correctly: a boilerplate banner line ("ORIGINAL FOR RECIPIENT")
 * above the vendor name, and a labelled "Vendor:" header.
 *
 * The number that matters is the SILENT ERROR RATE: documents that were damaged (or read wrongly)
 * and still scored at or above 0.85. A high accuracy on clean documents is easy; never being
 * confidently wrong is the point of scoring confidence from checks instead of from a model's mood.
 */
import { extract, type ExtractionSubmission } from "../lib/agent/extractor";

const args = process.argv.slice(2);
const useLlm = args.includes("--llm");
const N = Number(args.find((a) => a.startsWith("--n="))?.slice(4) ?? 240);
const SEED = Number(args.find((a) => a.startsWith("--seed="))?.slice(7) ?? 42);
if (!useLlm) process.env.GROQ_API_KEY = ""; // deterministic path only: the extractor then reports "template-incomplete" instead of calling a model
const THRESHOLD = 0.85;

// --- seeded RNG (mulberry32) so a run can be reproduced exactly ---
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n: number) => Math.round(n * 100) / 100;

const VENDORS = ["Acme Supply Co.", "Northwind Parts Ltd.", "Globex Logistics", "Initech Services", "Umbrella Industrial", "Stark Components", "Wayne Freight", "Hooli Cloud"];
const ITEMS = ["Steel Widget Bracket", "Zinc Plated Bolt M8x40", "Cloud GPU Hours", "Freight Surcharge", "Maintenance Kit", "Industrial Bearing Set", "Consulting Day", "Storage Allocation"];

interface Truth { vendor: string; number: string; date: string; po: string | null; lines: Array<{ description: string; quantity: number; unit_price: number }>; subtotal: number; tax: number; total: number }
type Damage = "none" | "wrong_total" | "missing_date" | "ocr_digit" | "ambiguous_date" | "unseen_layout" | "banner_line" | "labelled_vendor";
interface Doc { text: string; truth: Truth; damage: Damage; layout: string }

function makeTruth(i: number): Truth {
  const lines = Array.from({ length: int(1, 4) }, () => ({ description: pick(ITEMS), quantity: int(1, 40), unit_price: r2(int(150, 90000) / 100) }));
  const subtotal = r2(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0));
  const tax = r2(subtotal * pick([0, 0.05, 0.08, 0.18]));
  const m = int(1, 12), d = int(1, 28);
  return { vendor: pick(VENDORS), number: `INV-${int(1000, 9999)}-${i}`, date: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, po: rand() < 0.7 ? `PO-2026-${int(1000, 1999)}` : null, lines, subtotal, tax, total: r2(subtotal + tax) };
}

function render(t: Truth, layout: "block" | "inline", opts: { date?: string | null; total?: string; subtotal?: string } = {}): string {
  const date = opts.date === undefined ? t.date : opts.date;
  const out: string[] = [t.vendor, "INVOICE", `${layout === "block" ? "Invoice Number" : "Invoice #"}: ${t.number}`];
  if (date !== null) out.push(`${layout === "block" ? "Invoice Date" : "Date"}: ${date}`);
  if (t.po) out.push(`${layout === "block" ? "Purchase Order" : "PO Reference"}: ${t.po}`);
  out.push("", "Line Items:");
  t.lines.forEach((l, i) => {
    if (layout === "block") out.push(`${i + 1}. ${l.description}`, `   Qty: ${l.quantity}`, `   Unit Price: $${money(l.unit_price)}`);
    else out.push(`${i + 1}. ${l.description} - Qty ${l.quantity} - Unit Price $${money(l.unit_price)}`);
  });
  out.push(layout === "block" ? "---" : "", `Subtotal: $${opts.subtotal ?? money(t.subtotal)}`, `Tax: $${money(t.tax)}`, `${layout === "block" ? "Total Amount Due" : "Total"}: $${opts.total ?? money(t.total)}`, "Currency: USD");
  return out.join("\n");
}

function makeDoc(i: number): Doc {
  const truth = makeTruth(i);
  const layout = pick(["block", "inline"] as const);
  const damage = pick<Damage>(["none", "none", "none", "wrong_total", "missing_date", "ocr_digit", "ambiguous_date", "unseen_layout", "banner_line", "labelled_vendor"]);
  switch (damage) {
    case "wrong_total": return { truth, damage, layout, text: render(truth, layout, { total: money(truth.total + int(1, 900) / 10) }) };
    case "missing_date": return { truth, damage, layout, text: render(truth, layout, { date: null }) };
    case "ocr_digit": return { truth, damage, layout, text: render(truth, layout, { subtotal: money(truth.subtotal).replace(/\d/, "O") }) };
    case "ambiguous_date": {
      const [y, m, d] = truth.date.split("-");
      return { truth, damage, layout, text: render(truth, layout, { date: `${d}/${m}/${y}` }) };
    }
    case "banner_line":
      return { truth, damage, layout, text: `${pick(["ORIGINAL FOR RECIPIENT", "Page 1 of 2", "TAX INVOICE", "COPY"])}\n${render(truth, layout)}` };
    case "labelled_vendor":
      return { truth, damage, layout, text: render(truth, layout).replace(`${truth.vendor}\nINVOICE`, `INVOICE\nVendor: ${truth.vendor}`) };
    case "unseen_layout":
      return { truth, damage, layout: "free-form", text: `Thank you for your order!\nFrom ${truth.vendor}: ref ${truth.number} dated ${truth.date}.\nYou bought ${truth.lines.map((l) => `${l.quantity} x ${l.description} at ${money(l.unit_price)}`).join(", ")}.\nAmount payable ${money(truth.total)} (USD).` };
    default: return { truth, damage, layout, text: render(truth, layout) };
  }
}

/** Field-by-field comparison against ground truth. */
function wrongFields(got: ExtractionSubmission, t: Truth): string[] {
  const bad: string[] = [];
  if (got.vendor_name !== t.vendor) bad.push("vendor");
  if (got.invoice_number !== t.number) bad.push("number");
  if (got.invoice_date !== t.date) bad.push("date");
  if ((got.po_reference ?? null) !== t.po) bad.push("po");
  if (got.total == null || Math.abs(got.total - t.total) > 0.011) bad.push("total");
  if (got.line_items.length !== t.lines.length || got.line_items.some((l, i) => l.description !== t.lines[i].description || l.quantity !== t.lines[i].quantity || Math.abs(l.unit_price - t.lines[i].unit_price) > 0.011)) bad.push("lines");
  return bad;
}

async function main() {
  const docs = Array.from({ length: N }, (_, i) => makeDoc(i));
  type Row = { damage: Damage; confidence: number; flagged: boolean; wrong: string[]; method: string };
  const rows: Row[] = [];
  for (const d of docs) {
    const r = await extract(d.text);
    rows.push({ damage: d.damage, confidence: r.submission.confidence, flagged: r.submission.confidence < THRESHOLD, wrong: wrongFields(r.submission, d.truth), method: r.method });
  }

  const classes: Damage[] = ["none", "banner_line", "labelled_vendor", "wrong_total", "missing_date", "ocr_digit", "ambiguous_date", "unseen_layout"];
  const ordinary = new Set<Damage>(["none", "banner_line", "labelled_vendor"]);
  const pct = (a: number, b: number) => (b === 0 ? "–" : `${Math.round((a / b) * 100)}%`);
  console.log(`\nExtraction eval: ${N} synthetic invoices, seed ${SEED}, ${useLlm ? "template + LLM fallback" : "deterministic path only (no model)"}, bar ${THRESHOLD}\n`);
  console.log("| document class | n | sent to a person | read exactly right | silent errors* |");
  console.log("|---|---:|---:|---:|---:|");
  const label: Record<Damage, string> = { none: "clean (all fields present)", wrong_total: "total does not add up", missing_date: "invoice date missing", ocr_digit: "OCR digit swap (O for 0)", ambiguous_date: "ambiguous date 03/04/2026", unseen_layout: "layout the parser has never seen", banner_line: "banner line above the vendor (ordinary)", labelled_vendor: "labelled Vendor: header (ordinary)" };
  let silentTotal = 0, damagedTotal = 0, cleanSilentByClass = 0;
  for (const c of classes) {
    const xs = rows.filter((r) => r.damage === c);
    const flagged = xs.filter((r) => r.flagged).length;
    const exact = xs.filter((r) => r.wrong.length === 0).length;
    // Silent error: not flagged, and either damaged-by-construction or any field wrong.
    const silent = xs.filter((r) => !r.flagged && (ordinary.has(c) ? r.wrong.length > 0 : true)).length;
    if (!ordinary.has(c)) { silentTotal += silent; damagedTotal += xs.length; }
    else cleanSilentByClass += silent;
    console.log(`| ${label[c]} | ${xs.length} | ${pct(flagged, xs.length)} | ${pct(exact, xs.length)} | ${silent} |`);
  }
  const clean = rows.filter((r) => ordinary.has(r.damage));
  const falseFlags = clean.filter((r) => r.flagged).length;
  const cleanSilent = cleanSilentByClass;
  console.log(`\n* silent error = not sent to a person although the document was damaged, or a field was wrong.`);
  console.log(`Damaged documents let through: ${silentTotal} of ${damagedTotal} (${pct(silentTotal, damagedTotal)}).`);
  console.log(`Ordinary documents wrongly held for a person: ${falseFlags} of ${clean.length} (${pct(falseFlags, clean.length)}). Ordinary documents read wrong WITHOUT a flag: ${cleanSilent}.`);
  const methods = new Map<string, number>();
  for (const r of rows) methods.set(r.method, (methods.get(r.method) ?? 0) + 1);
  console.log(`Read by: ${[...methods].map(([m, n]) => `${m} ${n}`).join(", ")}`);
  // CI runs this: a damaged or wrongly-read document that is NOT sent to a person is a failure.
  if (silentTotal + cleanSilent > 0) {
    console.error(`\nFAIL: ${silentTotal + cleanSilent} silent error(s).`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
