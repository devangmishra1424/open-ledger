/**
 * Scores VeriBook's document pipeline (reader + field extraction) against the test set's answer keys.
 *
 *   npx tsx --env-file=.env eval/documents/run.ts [--no-llm] [--only tally_gst,us_invoice] [--forms photo.jpg] [--min-correct 340]
 *   (the document reader must be running: npm run reader)
 *
 * For every document it compares each field to truth.json and sorts the outcome three ways:
 *   correct          the field is right
 *   flagged          the field is wrong or missing, AND VeriBook said so (the field is listed as uncertain, or
 *                    the reading's confidence is under the 85% bar, so a person checks it before anything is paid)
 *   SILENT           the field is wrong and nothing flagged it. This is the number that must be zero: a wrong
 *                    value a person is told to check is a slower invoice; a wrong value nobody is told about is
 *                    a wrong payment.
 *
 * Readings are kept by file hash in eval/documents/readings/ (committed: the reader is slow and heavy, so CI scores
 * field extraction on these saved readings without running OCR). --fresh re-reads through the running reader;
 * --cached-only never calls the reader (CI) and fails if a reading is missing. Regenerate the saved readings
 * after changing the reader: docreader/.venv/Scripts/python eval/documents/read_all.py --fresh
 * Private invoices (eval/documents/private/<name>/, never committed) are scored the same way when they have a
 * truth.json, and only read and printed when they do not.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { readDocument, type Reading } from "@/lib/documents/reader-client";
import { extractInvoice, REVIEW_THRESHOLD } from "@/lib/documents/invoice";

const ROOT = join(process.cwd(), "eval", "documents");
const CACHE = join(ROOT, "readings");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]?.split(",") : undefined;
};
const onlyLayouts = option("--only");
const onlyForms = option("--forms");
const useLlm = !flag("--no-llm");
const fresh = flag("--fresh");
const cachedOnly = flag("--cached-only");

interface Truth {
  vendor_name: string; invoice_number: string; invoice_date: string; po_reference: string | null; currency: string;
  line_items: Array<{ description: string; quantity: number; unit_price: number }>;
  subtotal: number; tax: number; charges: number; discount: number; round_off: number; total: number;
}

type Outcome = "correct" | "flagged" | "SILENT";
const FIELDS = ["vendor_name", "invoice_number", "invoice_date", "po_reference", "currency", "line_items", "subtotal", "tax", "total"] as const;

const MEDIA: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".png": "image/png", ".docx": "application/octet-stream", ".xlsx": "application/octet-stream" };

async function cachedReading(path: string): Promise<Reading> {
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const file = join(CACHE, `${hash}.json`);
  if (!fresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (cachedOnly) throw new Error(`no saved reading for ${path} (run eval/documents/read_all.py)`);
  const reading = await readDocument({ bytes, filename: basename(path), mediaType: MEDIA[extname(path)] });
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(reading));
  return reading;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/**
 * Same text, allowing the slips OCR makes in a description (a dropped space, "8" read as "&", a stray full stop):
 * most words shared, or at least 90% the same letters. A description is never money, and a wrong ITEM still fails.
 */
function similar(a: string, b: string): boolean {
  const wa = words(a), wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  if (shared / Math.max(wa.size, wb.size) >= 0.6) return true;
  const sa = norm(a).replace(/\s/g, ""), sb = norm(b).replace(/\s/g, "");
  return 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length) >= 0.9;
}
const money = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) <= 0.011;

function linesMatch(got: Array<{ description: string; quantity: number; unit_price: number }>, want: Truth["line_items"]): boolean {
  if (got.length !== want.length) return false;
  return want.every((w, i) => {
    const g = got[i];
    return Math.abs(g.quantity - w.quantity) <= 0.001 && Math.abs(g.unit_price - w.unit_price) <= 0.011 && similar(g.description, w.description);
  });
}

function fieldCorrect(field: (typeof FIELDS)[number], got: Record<string, any>, want: Truth): boolean {
  switch (field) {
    case "vendor_name": return similar(got.vendor_name ?? "", want.vendor_name);
    case "invoice_number": return norm(got.invoice_number) === norm(want.invoice_number);
    case "po_reference": return norm(got.po_reference) === norm(want.po_reference);
    case "invoice_date": case "currency": return (got[field] ?? null) === want[field];
    case "line_items": return linesMatch(got.line_items ?? [], want.line_items);
    case "tax": return money(got.tax ?? 0, want.tax);
    default: return money(got[field], (want as any)[field]);
  }
}

interface Row { doc: string; form: string; seconds: number; ocr: string; method: string; confidence: number; outcomes: Record<string, Outcome>; notes: string[] }

async function score(path: string, truth: Truth | null, label: string, form: string): Promise<Row | null> {
  const t0 = Date.now();
  let reading: Reading;
  try {
    reading = await cachedReading(path);
  } catch (e) {
    console.log(`${label}/${form}: READ FAILED: ${(e as Error).message}`);
    return { doc: label, form, seconds: (Date.now() - t0) / 1000, ocr: "-", method: "read failed", confidence: 0,
      outcomes: Object.fromEntries(FIELDS.map((f) => [f, "flagged" as Outcome])), notes: [(e as Error).message] };
  }
  const result = await extractInvoice(reading, { llm: useLlm });
  const s = result.submission;
  const needsPerson = s.confidence < REVIEW_THRESHOLD;
  const outcomes: Record<string, Outcome> = {};
  const notes: string[] = [];
  for (const f of FIELDS) {
    if (!truth) continue;
    if (fieldCorrect(f, s, truth)) { outcomes[f] = "correct"; continue; }
    const flaggedField = s.uncertain_fields.some((u) => u.startsWith(f) || u.includes(f.replace("_", " ")));
    outcomes[f] = flaggedField || needsPerson ? "flagged" : "SILENT";
    const shown = f === "line_items" ? `${(s.line_items ?? []).length} lines` : JSON.stringify((s as any)[f]);
    notes.push(`${f}: got ${shown}, want ${f === "line_items" ? `${truth.line_items.length} lines` : JSON.stringify((truth as any)[f])}`);
  }
  if (!truth) {
    console.log(`\n${label}/${form}: ${result.method}, ${Math.round(s.confidence * 100)}%`, JSON.stringify(s, null, 1));
  }
  return {
    doc: label, form, seconds: (reading.timing_ms.total ?? 0) / 1000,
    ocr: reading.ocr_used ? (reading.ocr_confidence ?? 0).toFixed(2) : "-",
    method: result.method, confidence: s.confidence, outcomes, notes: [...notes, ...s.uncertain_fields.map((u) => `uncertain: ${u}`)],
  };
}

async function main() {
  const rows: Row[] = [];
  const invoicesDir = join(ROOT, "invoices");
  for (const layout of readdirSync(invoicesDir).filter((d) => existsSync(join(invoicesDir, d, "truth.json")))) {
    if (onlyLayouts && !onlyLayouts.includes(layout)) continue;
    const truth: Truth = JSON.parse(readFileSync(join(invoicesDir, layout, "truth.json"), "utf8"));
    for (const file of readdirSync(join(invoicesDir, layout)).filter((f) => f !== "truth.json").sort()) {
      if (onlyForms && !onlyForms.includes(file)) continue;
      const row = await score(join(invoicesDir, layout, file), truth, layout, file);
      if (row) rows.push(row);
    }
  }
  const privateDir = join(ROOT, "private");
  if (existsSync(privateDir)) {
    for (const name of readdirSync(privateDir)) {
      const dir = join(privateDir, name);
      const files = readdirSync(dir).filter((f) => f !== "truth.json");
      const truth = existsSync(join(dir, "truth.json")) ? JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) : null;
      for (const file of files) {
        const row = await score(join(dir, file), truth, `private/${name}`, file);
        if (row && truth) rows.push(row);
      }
    }
  }

  const count = (o: Outcome) => rows.reduce((n, r) => n + Object.values(r.outcomes).filter((x) => x === o).length, 0);
  const allRight = rows.filter((r) => Object.values(r.outcomes).every((o) => o === "correct")).length;
  const silentDocs = rows.filter((r) => Object.values(r.outcomes).includes("SILENT"));

  console.log("\n doc / form                         method          conf   ocr   secs  result");
  for (const r of rows) {
    const bad = Object.entries(r.outcomes).filter(([, o]) => o !== "correct");
    const verdict = bad.length === 0 ? "all fields correct" : bad.map(([f, o]) => `${f}:${o}`).join(" ");
    console.log(` ${`${r.doc}/${r.form}`.padEnd(34)} ${r.method.padEnd(15)} ${String(Math.round(r.confidence * 100)).padStart(3)}%  ${r.ocr.padStart(4)}  ${r.seconds.toFixed(1).padStart(5)}  ${verdict}`);
  }
  const total = rows.length * FIELDS.length;
  console.log(`\nDocuments: ${rows.length}; every field correct: ${allRight}/${rows.length}`);
  console.log(`Fields: ${total}; correct ${count("correct")}, wrong-but-flagged ${count("flagged")}, SILENT ${count("SILENT")}`);
  if (silentDocs.length) {
    console.log("\nSILENT errors (wrong and not flagged):");
    for (const r of silentDocs) console.log(`  ${r.doc}/${r.form}: ${r.notes.filter((n) => !n.startsWith("uncertain")).join("; ")}`);
  }
  writeFileSync(join(ROOT, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), llm: useLlm, rows }, null, 2) + "\n");
  // CI gate: any silent error fails, and so does a drop in accuracy below --min-correct (a regression in the rules)
  const minCorrect = Number(option("--min-correct")?.[0] ?? 0);
  if (count("correct") < minCorrect) console.log(`
FAIL: ${count("correct")} fields correct, below the floor of ${minCorrect}`);
  process.exitCode = silentDocs.length > 0 || count("correct") < minCorrect ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
