import { dateOrderFor, detectCurrency, parseAmount, parseDate, type DateOrder } from "@/lib/documents/formats";
import { documentText, rowsFromReading, type DocCell, type DocRow } from "@/lib/documents/layout";
import { isFieldLabel, LABELS, labelledValue, parseQty } from "@/lib/documents/invoice-rules";
import type { Reading } from "@/lib/documents/reader-client";
import { descriptionSimilarity } from "@/lib/matching/line-match";

/**
 * A goods-receipt document read into a DRAFT for the receipt form. Three kinds are read the same way:
 *  - a delivery note / delivery challan (the vendor's, sent with the goods),
 *  - a goods receipt note, GRN (your stores' record of what came in, often split into accepted and rejected),
 *  - a packing slip (the vendor's list of what is in the box).
 * What it gives: the PO number the document cites, its own number, its date, who received the goods, and for each
 * item the quantity that came in. No AI is used; what cannot be read is named in `missing` for the person to type.
 *
 * Which printed column is "the quantity received" depends on the document: Accepted (a GRN that separates accepted
 * from rejected) before Received / Shipped / Delivered / Dispatched, before a plain Quantity. Ordered and
 * Backordered are never taken as received. A rejected quantity is kept on the line, as is a remark.
 */

export interface ReceiptLine {
  description: string;
  code: string | null;
  uom: string | null;
  /** The quantity received (accepted, when the document separates the two); null when it could not be read. */
  quantity: number | null;
  ordered: number | null;
  rejected: number | null;
  remark: string | null;
  /** What about this line does not add up or could not be read, in plain words; null when it checks out. */
  problem: string | null;
}

export interface ReceiptDraft {
  /** The document's own number: challan, GRN, delivery note or packing slip number. */
  documentNumber: string | null;
  poNumber: string | null;
  receiptDate: string | null;
  /** The label the date was printed under, as printed ("GRN Date", "Ship Date"). */
  dateLabel: string | null;
  /** "received": the day the goods came in (a GRN, "Received on"). "document": the day the document was made out,
   *  usually the day the goods were SENT (a challan or packing slip); the goods may have arrived later. */
  dateKind: "received" | "document" | null;
  receiverName: string | null;
  /** The printed column the quantities were taken from ("Accepted", "Qty Shipped", "Quantity"). */
  quantityColumn: string | null;
  lines: ReceiptLine[];
  /** What could not be read or does not add up, in plain words. Empty when every field was found (still worth checking). */
  missing: string[];
}

// ------------------------------------------------------------------------------------------------ item table

type Role = "serial" | "code" | "description" | "uom" | "ordered" | "backordered" | "rejected" | "accepted" | "received" | "qty" | "value" | "remarks";

// Order matters: the first pattern that fits names the column ("Qty Shipped" is received, not a plain qty; "Item #"
// is a code, "Item" a description; "Backordered" is not "Ordered").
const ROLE_PATTERNS: Array<[Role, RegExp]> = [
  ["code", /^item\s*(?:#|no\.?|code|id)$|\b(?:hsn|sac|code|sku|part\s*(?:no|number|#)|cat(?:alog(?:ue)?)?\.?\s*(?:no|#))\b/i],
  ["serial", /^(?:s\.?\s*no\.?|sr\.?(?:\s*no\.?)?|sl\.?(?:\s*no\.?)?|si|#|no\.?|line)$/i],
  ["backordered", /\bback\s*-?\s*order(?:ed)?\b|\b(?:balance|pending|to\s*follow)\b/i],
  ["rejected", /\b(?:rejected|rej\.?|returned|damaged|short(?:age)?)\b/i],
  ["accepted", /\b(?:accepted|acc\.?|approved|passed)\b/i],
  ["ordered", /\b(?:ordered|order\s*qty|po\s*qty)\b/i],
  ["received", /\b(?:received|recd\.?|rcvd\.?|delivered|dispatched|despatched|shipped|supplied|sent)\b/i],
  ["qty", /\b(?:qty|quantity|qnty)\b/i],
  ["uom", /^(?:uom|u\.o\.m\.?|units?|units?\s*of\s*measure|per)$/i],
  ["value", /\b(?:rate|price|amount|value|cost|weight|wt\.?)\b/i],
  ["remarks", /\b(?:remarks?|notes?|comments?|condition)\b/i],
  ["description", /\b(?:description|particulars|items?|products?|goods|material|article|details)\b/i],
];

/** The columns that can hold "what came in", best first. */
const QUANTITY_ROLES: Role[] = ["accepted", "received", "qty"];
const NUMERIC_ROLES: Role[] = ["serial", "ordered", "backordered", "rejected", "accepted", "received", "qty", "value"];

interface Column { role: Role; x0: number; x1: number; label: string }

function roleOf(text: string): Role | null {
  const t = text.replace(/[()₹$€£:]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return null;
  for (const [role, re] of ROLE_PATTERNS) if (re.test(t)) return role;
  return null;
}

function headerColumns(row: DocRow): Column[] | null {
  if (row.cells.some((c) => /\d{2,}/.test(c.text))) return null; // a data row, not a header
  const cols = row.cells.map((c) => ({ role: roleOf(c.text), x0: c.x0, x1: c.x1, label: c.text.trim() })).filter((c): c is Column => c.role !== null);
  const roles = new Set(cols.map((c) => c.role));
  if (!roles.has("description") || !QUANTITY_ROLES.some((r) => roles.has(r))) return null;
  if (row.cells.length - cols.length > 1) return null; // a sentence that happens to say "goods received", not a header
  return cols;
}

/** OCR reads a decimal point as a colon now and then ("4:500" for 4.500). Only ever applied inside the item table. */
function repairNumber(text: string): { text: string; repaired: boolean } {
  const t = text.trim();
  const m = t.match(/^(\d+)[:;](\d{1,3})$/);
  return m ? { text: `${m[1]}.${m[2]}`, repaired: true } : { text: t, repaired: false };
}

const looksNumeric = (text: string) => parseQty(repairNumber(text).text).qty != null;

function overlap(a: { x0: number; x1: number }, b: { x0: number; x1: number }): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
}

function columnByPosition(cell: DocCell, cols: Column[], row: DocRow): number {
  if (!row.positioned) {
    const i = Math.round(cell.x0 / 100);
    return i < cols.length ? i : -1;
  }
  let best = -1, bestOverlap = 0;
  cols.forEach((col, i) => {
    const o = overlap(cell, col);
    if (o > bestOverlap) { bestOverlap = o; best = i; }
  });
  if (best >= 0) return best;
  const cx = (cell.x0 + cell.x1) / 2;
  let nearest = -1, dist = Infinity;
  cols.forEach((col, i) => {
    const d = Math.abs((col.x0 + col.x1) / 2 - cx);
    if (d < dist) { dist = d; nearest = i; }
  });
  return dist < 80 ? nearest : -1;
}

/**
 * Which column each cell of an item row belongs to, by ORDER first (printed numbers are right-aligned and drift
 * from their header; their order does not): number cells left to right go to the number columns, text cells to the
 * text columns (extra text joins the description; a missing trailing remark is just blank). A code column (HSN,
 * Item #) can hold numbers or text, so both are tried. Only when the counts do not line up is each cell placed by
 * its position under the header.
 */
function assignCells(row: DocRow, cols: Column[]): Map<number, DocCell[]> {
  const numeric = row.cells.filter((c) => looksNumeric(c.text));
  const text = row.cells.filter((c) => !looksNumeric(c.text));
  for (const codeIsNumeric of [true, false]) {
    const isNumericCol = (c: Column) => NUMERIC_ROLES.includes(c.role) || (c.role === "code" && codeIsNumeric);
    const numericCols = cols.map((c, i) => [c, i] as const).filter(([c]) => isNumericCol(c)).map(([, i]) => i);
    const textCols = cols.map((c, i) => [c, i] as const).filter(([c]) => !isNumericCol(c)).map(([, i]) => i);
    if (numeric.length !== numericCols.length || text.length === 0 || textCols.length === 0) continue;
    const out = new Map<number, DocCell[]>();
    numeric.forEach((cell, k) => out.set(numericCols[k], [cell]));
    const extra = Math.max(0, text.length - textCols.length);
    let t = 0;
    for (const i of textCols) {
      if (t >= text.length) break;
      const take = cols[i].role === "description" ? 1 + extra : 1;
      out.set(i, text.slice(t, t + take));
      t += take;
    }
    return out;
  }
  const out = new Map<number, DocCell[]>();
  for (const cell of row.cells) {
    const i = columnByPosition(cell, cols, row);
    if (i >= 0) out.set(i, [...(out.get(i) ?? []), cell]);
  }
  return out;
}

const END_OF_TABLE = /^(?:total|grand\s*total|sub\s*-?\s*total|total\s*(?:qty|quantity|items?))\b/i;
const close = (a: number, b: number) => Math.abs(a - b) <= 0.0005 * Math.max(1, Math.abs(b));

interface ItemRead { lines: ReceiptLine[]; quantityColumn: string | null }

function readItems(rows: DocRow[]): ItemRead {
  const headerIndex = rows.findIndex((r) => headerColumns(r) !== null);
  if (headerIndex < 0) return { lines: [], quantityColumn: null };
  let cols = headerColumns(rows[headerIndex])!;
  const quantityRole = QUANTITY_ROLES.find((r) => cols.some((c) => c.role === r))!;
  const quantityColumn = cols.find((c) => c.role === quantityRole)!.label;
  const has = (role: Role) => cols.some((c) => c.role === role);

  const lines: ReceiptLine[] = [];
  let lastItemRow = -1;
  let descriptionStart = Infinity;
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (headerColumns(row)) { cols = headerColumns(row)!; continue; } // the header repeated on the next page
    const firstWords = row.cells.find((c) => /[A-Za-z]/.test(c.text))?.text ?? "";
    if (END_OF_TABLE.test(firstWords.trim())) break;

    const byColumn = assignCells(row, cols);
    const cellsOf = (role: Role) => cols.flatMap((c, i) => (c.role === role ? byColumn.get(i) ?? [] : []));
    const textOf = (role: Role) => cellsOf(role).map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
    const numberOf = (role: Role) => {
      const cell = cellsOf(role)[0];
      if (!cell) return { value: null, repaired: false, uom: null };
      const fixed = repairNumber(cell.text);
      const q = parseQty(fixed.text);
      return { value: q.qty, repaired: fixed.repaired, uom: q.uom };
    };

    let description = textOf("description");
    const quantities = QUANTITY_ROLES.map((role) => [role, numberOf(role)] as const);
    const hasNumbers = row.cells.some((c) => looksNumeric(c.text));

    if (!hasNumbers) {
      // A second line of the previous item's description, printed under it; anything else (a note, "Received the
      // above goods in good condition", "Received by: ...", the signature block) ends the table. On a page that is
      // where the text sits; in a Word/Excel/markdown table (no positions) it is a table row with only the
      // description cell filled, never a free line of text after the table.
      const filled = row.cells.filter((c) => c.text.trim());
      const only = filled.length === 1 ? filled[0] : null;
      const prev = lines[lines.length - 1];
      const description = cols.find((c) => c.role === "description");
      const underDescription = only != null && !isFieldLabel(only.text.trim()) && !RECEIVER.test(only.text.trim()) && (row.positioned
        ? only.x0 >= descriptionStart - 20 && cols.every((c) => c.role === "description" || overlap(only, c) <= 0)
        : row.cells.length > 1 && only.x0 === description?.x0);
      if (prev && only && r === lastItemRow + 1 && underDescription && /[A-Za-z]{2}/.test(only.text)) {
        prev.description = `${prev.description} ${only.text.trim()}`;
        lastItemRow = r;
        continue;
      }
      if (lines.length > 0) break;
      continue;
    }
    if (!description || !/[A-Za-z]{2}/.test(description)) continue;
    if (!has("serial")) description = description.replace(/^\d{1,3}[.)]?\s+(?=[A-Za-z])/, "");
    descriptionStart = Math.min(descriptionStart, ...cellsOf("description").map((c) => c.x0));

    const [role, picked] = quantities.find(([, q]) => q.value != null) ?? [null, { value: null, repaired: false, uom: null }];
    const received = numberOf("received");
    const accepted = numberOf("accepted");
    const rejected = numberOf("rejected");
    const ordered = numberOf("ordered");
    let problem: string | null = null;
    const label = description.slice(0, 40);

    if (picked.value == null) {
      problem = `"${label}": could not read the quantity received`;
    } else if (role !== quantityRole) {
      problem = `"${label}": the ${quantityColumn} column is blank; took ${picked.value} from the ${cols.find((c) => c.role === role)?.label ?? role} column`;
    } else if (has("accepted") && has("received") && has("rejected")) {
      // a GRN: what came in = what was accepted + what was rejected, on every line
      if (received.value == null || accepted.value == null || rejected.value == null || !close(received.value, accepted.value + rejected.value)) {
        problem = `"${label}": received ${received.value ?? "?"} is not accepted ${accepted.value ?? "?"} + rejected ${rejected.value ?? "?"}`;
      }
    }
    // A repaired OCR slip that no check confirmed is said out loud.
    const repairedUsed = (picked.repaired || received.repaired || accepted.repaired) && !(has("accepted") && has("received") && has("rejected") && problem === null);
    if (!problem && repairedUsed) problem = `"${label}": a quantity was printed unclearly; read as ${picked.value}, check it`;

    lines.push({
      description,
      code: textOf("code") || null,
      uom: textOf("uom") || picked.uom || null,
      quantity: picked.value,
      ordered: ordered.value,
      rejected: rejected.value,
      remark: textOf("remarks") || null,
      problem,
    });
    lastItemRow = r;
  }
  return { lines, quantityColumn };
}

// ------------------------------------------------------------------------------------------------ labelled fields

const DOC_NUMBER = /^(?:(?:delivery\s*)?challan\s*(?:no\.?|number|#)|d\.?\s*c\.?\s*(?:no\.?|number|#)|delivery\s*(?:note|order|receipt)\s*(?:no\.?|number|#)|(?:g\.?\s*r\.?\s*n|m\.?\s*r\.?\s*n)\.?\s*(?:no\.?|number|#)|goods\s*receipt\s*(?:note\s*)?(?:no\.?|number|#)|packing\s*(?:slip|list|note)\s*(?:no\.?|number|#)|(?:dispatch|despatch|shipment|shipping)\s*(?:note\s*|advice\s*)?(?:no\.?|number|#|id)|receipt\s*(?:no\.?|number|#))(?=[\s:#.]|$)/i;
const RECEIVED_DATE = /^(?:(?:grn|g\.\s*r\.\s*n\.?|m\.?r\.?n|receipt|receiving|received|goods\s*receipt|inward|arrival|delivery|delivered)\s*(?:date|on|dt\.?)|date\s*of\s*(?:receipt|arrival|delivery)|received\s*on)(?=[\s:.\-]|$)/i;
const DOCUMENT_DATE = /^(?:(?:challan|d\.?\s*c\.?|ship(?:ment|ping)?|dispatch|despatch|packing\s*slip|note|document)\s*date|date\s*of\s*(?:dispatch|despatch|shipment|issue)|date|dated|dt\.?)(?=[\s:.\-]|$)/i;
const RECEIVER = /^(?:(?:goods\s*)?received\s*by|receiver(?:'s)?(?:\s*name)?|recd\.?\s*by|rcvd\.?\s*by|checked\s*(?:and|&)\s*received\s*by)(?=[\s:.\-]|$)/i;
const NOT_A_NAME = /^(?:signature|sign\b|stamp|seal|name\b|date\b|authori[sz]ed|signatory|designation|for\s|with\s|the\s)/i;
const IS_GRN = /\bgoods\s*receipt\s*note\b|\bG\.?\s?R\.?\s?N\.?\b|\binward\s*(?:note|register|entry)\b|\bmaterial\s*receipt\b/i;

function acceptName(s: string): string | null {
  // A name runs up to the next label on the same line: "R. Yadav (Stores) Condition: Accepted" is "R. Yadav (Stores)".
  const v = s.replace(/\s+/g, " ").trim().replace(/\s+(?:condition|date|signature|sign|remarks?|time|vehicle(?:\s*no\.?)?)\s*[:.].*$/i, "").trim();
  if (v.length < 2 || v.length > 80 || !/[A-Za-z]{2}/.test(v) || NOT_A_NAME.test(v) || isFieldLabel(v)) return null;
  return v;
}

/**
 * The order an all-number date is read in. The PO's currency is the best hint (the read route passes it); without
 * it, an Indian document (a "challan", "Pvt Ltd", a GSTIN) is day-first and a US address (state + ZIP) month-first.
 */
function receiptDateOrder(currencyHint: string | null, text: string): DateOrder {
  const fromCurrency = dateOrderFor(currencyHint ?? detectCurrency(text), text);
  if (fromCurrency) return fromCurrency;
  if (/\bchallan\b|\bpvt\.?\s*ltd\b|\bGSTIN\b/i.test(text)) return "DMY";
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text)) return "MDY";
  return null;
}

export function readGoodsReceipt(reading: Reading, opts: { currencyHint?: string | null } = {}): ReceiptDraft {
  const rows = rowsFromReading(reading);
  const text = documentText(rows);
  const order = receiptDateOrder(opts.currencyHint ?? null, text);

  const documentNumber = labelledValue(rows, DOC_NUMBER, "id");
  const poNumber = labelledValue(rows, LABELS.po, "id");
  const receivedDate = labelledValue(rows, RECEIVED_DATE, "date", order);
  const dated = receivedDate ?? labelledValue(rows, DOCUMENT_DATE, "date", order);
  const parsedDate = dated ? parseDate(dated.value, order) : null;
  const dateKind = !dated ? null : receivedDate || IS_GRN.test(text) ? "received" : "document";
  const receiver = labelledValue(rows, RECEIVER, acceptName);
  const { lines, quantityColumn } = readItems(rows);

  const missing: string[] = [];
  if (!poNumber) missing.push("the PO number (the document does not print one that could be read)");
  if (!documentNumber) missing.push("the document's own number (challan / GRN / packing slip no.)");
  if (!parsedDate) missing.push("the date");
  else if (parsedDate.ambiguous) missing.push(`the date for certain: ${dated!.value} could be day-first or month-first, read as ${parsedDate.iso}`);
  if (lines.length === 0) missing.push("the item lines (no table with a description and a quantity column was found)");
  for (const l of lines) if (l.problem) missing.push(l.problem);
  if ([documentNumber, poNumber, receiver].some((f) => f?.conf != null)) missing.push("this was read by OCR: check the PO number and quantities digit by digit");

  return {
    documentNumber: documentNumber?.value ?? null,
    poNumber: poNumber?.value ?? null,
    receiptDate: parsedDate?.iso ?? null,
    dateLabel: dated?.label ?? null,
    dateKind,
    receiverName: receiver?.value ?? null,
    quantityColumn,
    lines,
    missing,
  };
}

// ------------------------------------------------------------------------------------------------ against the PO

export interface PoLineForReceipt { lineNumber: number; description: string; uom: string | null; ordered: number; received: number }

export interface ReceiptMatch {
  /** One entry per PO line: the quantity the document gives for it, or null when the document has no line for it. */
  poLines: Array<{ lineNumber: number; quantity: number | null; documentLine: number | null; similarity: number | null; sure: boolean }>;
  /** Document lines (1-based) that match no PO line. */
  unmatched: Array<{ documentLine: number; description: string; quantity: number | null }>;
  /** Things the person should look at before saving, in plain words. */
  warnings: string[];
}

/** Below this, two descriptions are not taken as the same item. Calibrated on name variants ("Black Pepper" for
 *  "Black Pepper Whole (Grade A, 550 GL)" scores 0.29; "Hex Bolt M10x50 ZP" 0.32) against different items (<= 0.05). */
const MIN_SIMILARITY = 0.25;
/** Below this, a match is offered but marked for checking. */
const SURE_SIMILARITY = 0.6;

const squashId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const numbersIn = (s: string) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);

/** The document line prints a number (a size, a grade, a pack weight) that the PO line does not: "Spring Washer M12"
 *  against "Spring Washer M10" is a different item however alike the names are, so it is never matched. */
function numbersConflict(documentDescription: string, poDescription: string): boolean {
  const po = numbersIn(poDescription);
  return po.size > 0 && [...numbersIn(documentDescription)].some((n) => !po.has(n));
}

/**
 * Which PO line each document line is, by description: every pair is scored (trigram similarity, the same measure
 * the invoice-to-PO match uses) and the best pairs are taken first, each line used once. A pair below MIN_SIMILARITY,
 * or one whose sizes/numbers differ, is never matched: the line is listed as unmatched for the person to enter, not
 * guessed. A match below SURE_SIMILARITY is marked so the form says "check this line".
 */
export function matchReceiptToPo(draft: ReceiptDraft, po: { poNumber: string; lines: PoLineForReceipt[] }): ReceiptMatch {
  const pairs: Array<{ d: number; p: number; sim: number }> = [];
  draft.lines.forEach((dl, d) => po.lines.forEach((pl, p) => {
    if (!numbersConflict(dl.description, pl.description)) pairs.push({ d, p, sim: descriptionSimilarity(dl.description, pl.description) });
  }));
  pairs.sort((a, b) => b.sim - a.sim);
  const docTaken = new Map<number, { p: number; sim: number }>();
  const poTaken = new Map<number, number>();
  for (const pair of pairs) {
    if (pair.sim < MIN_SIMILARITY) break;
    if (docTaken.has(pair.d) || poTaken.has(pair.p)) continue;
    docTaken.set(pair.d, { p: pair.p, sim: pair.sim });
    poTaken.set(pair.p, pair.d);
  }

  const warnings: string[] = [];
  if (draft.poNumber && squashId(draft.poNumber) !== squashId(po.poNumber)) {
    warnings.push(`The document cites purchase order ${draft.poNumber}, not ${po.poNumber}. Check it is being recorded against the right PO.`);
  }
  const poLines = po.lines.map((pl, p) => {
    const d = poTaken.get(p);
    if (d === undefined) return { lineNumber: pl.lineNumber, quantity: null, documentLine: null, similarity: null, sure: false };
    const { sim } = docTaken.get(d)!;
    const dl = draft.lines[d];
    const due = Math.max(0, pl.ordered - pl.received);
    if (dl.quantity != null && dl.quantity > due + 1e-9) {
      warnings.push(`Line ${pl.lineNumber} (${pl.description}): the document says ${dl.quantity} came in, but only ${due} of the ${pl.ordered} ordered ${due === 1 ? "is" : "are"} still due.`);
    }
    if (dl.rejected) warnings.push(`Line ${pl.lineNumber}: ${dl.rejected} rejected${dl.remark ? ` (${dl.remark})` : ""}; only the accepted quantity is filled in.`);
    if (sim < SURE_SIMILARITY) warnings.push(`Line ${pl.lineNumber} was matched to "${dl.description}" by a similar name: check it is the same item.`);
    return { lineNumber: pl.lineNumber, quantity: dl.quantity, documentLine: d + 1, similarity: Math.round(sim * 100) / 100, sure: sim >= SURE_SIMILARITY };
  });
  const unmatched = draft.lines.flatMap((dl, d) => (docTaken.has(d) ? [] : [{ documentLine: d + 1, description: dl.description, quantity: dl.quantity }]));
  for (const u of unmatched) warnings.push(`"${u.description}" (${u.quantity ?? "?"}) matches no line on this PO, so it was left out. Enter it by hand if it is one of the PO's lines under another name.`);
  return { poLines, unmatched, warnings };
}
