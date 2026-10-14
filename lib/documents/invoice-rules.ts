import { amountsIn, DATE_TOKEN, dateOrderFor, detectCurrency, parseAmount, parseDate, type DateOrder } from "@/lib/documents/formats";
import { documentText, type DocCell, type DocRow } from "@/lib/documents/layout";

/**
 * Reading invoice fields out of a document's positioned rows with deterministic rules — no AI. Works from where
 * things are on the page:
 *  - the item table: a header row names the columns (description, qty, rate, amount, discount, tax...), each row
 *    below is read cell by column, and every row is checked (qty x rate [less discount] = amount);
 *  - labelled fields: "Invoice No." / "Dated" / "P.O.#" with the value in the same cell, the next cell, or the cell
 *    printed under the label;
 *  - the totals block: subtotal, each tax line (CGST, SGST, IGST, VAT...), charges, discount, round off, total;
 *  - the vendor: a "From:"/"Supplier:" label, the "for <Company>" signature line, or the letterhead (never the
 *    "Bill to" block).
 * Anything it cannot read is left null and named in `problems`; it never fills a gap with a guess.
 */

export interface RuleLine { description: string; quantity: number; unit_price: number; uom: string | null; amount: number | null; problem: string | null; conf: number | null }

export interface RuleReading {
  vendor_name: string | null;
  vendor_from: "label" | "signature" | "letterhead" | null;
  /** The vendor's name is backed by more than its position (a label, the signature, a repeat, a legal form). */
  vendor_corroborated: boolean;
  vendor_tax_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  date_ambiguous: boolean;
  due_date: string | null;
  po_reference: string | null;
  currency: string | null;
  line_items: RuleLine[];
  subtotal: number | null;
  tax: number | null;
  tax_lines: Array<{ label: string; amount: number }>;
  other_charges: Array<{ label: string; amount: number }>;
  discount: number | null;
  round_off: number | null;
  total: number | null;
  /** OCR confidence of the cells each identifier was read from (null when not OCR'd). */
  field_conf: Record<string, number | null>;
  problems: string[];
}

// ------------------------------------------------------------------------------------------------ item table

type Role = "serial" | "description" | "code" | "qty" | "uom" | "rate" | "discount" | "tax_rate" | "tax_amount" | "taxable" | "amount" | "line_total";

const ROLE_PATTERNS: Array<[Role, RegExp]> = [
  ["tax_amount", /\b(?:[csi]|ut)?gst\s*(?:amt|amount|value)\b|\b(?:vat|tax)\s*(?:amt|amount|value)\b/i],
  ["taxable", /\btaxable\b/i],
  ["tax_rate", /\b(?:[csi]|ut)?gst\s*(?:%|rate)|\b(?:vat|tax)\s*(?:%|rate)\b|^(?:[csi]|ut)?gst\s*%?$|^vat\s*%?$/i],
  ["discount", /\bdisc(?:ount)?\.?\b/i],
  ["serial", /^(?:s\.?\s*no\.?|sr\.?(?:\s*no\.?)?|sl\.?(?:\s*no\.?)?|#|no\.?|line)$/i],
  ["description", /\b(?:description|particulars|items?|product|goods|services?|details|material)\b/i],
  ["code", /\b(?:hsn|sac|code|sku|part\s*(?:no|number))\b/i],
  ["qty", /\b(?:qty|quantity|qnty)\b|^(?:hrs?|hours)$/i],
  ["uom", /^(?:uom|units?|units?\s*of\s*measure|per)$/i],
  ["rate", /\b(?:rate|unit\s*price|price|unit\s*cost|cost)\b/i],
  ["line_total", /^total(?:\s*amount)?$/i],
  ["amount", /\b(?:amount|amt|value|net|ext(?:ended)?\.?\s*price|line\s*total)\b/i],
];

function roleOf(text: string): Role | null {
  const t = text.replace(/[()₹$€£:]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return null;
  for (const [role, re] of ROLE_PATTERNS) if (re.test(t)) return role;
  return null;
}

interface Column { role: Role; x0: number; x1: number; label: string }

const NUMERIC_ROLES: Role[] = ["qty", "rate", "amount", "taxable", "line_total"];

function headerColumns(row: DocRow): Column[] | null {
  const cols = row.cells.map((c) => ({ role: roleOf(c.text), x0: c.x0, x1: c.x1, label: c.text })).filter((c): c is Column => c.role !== null);
  const roles = new Set(cols.map((c) => c.role));
  const numeric = NUMERIC_ROLES.filter((r) => roles.has(r)).length;
  if (!roles.has("description") || numeric < 1) return null;
  if (numeric < 2 && !roles.has("amount") && !roles.has("taxable")) return null;
  if (row.cells.some((c) => /\d{3,}/.test(c.text) && !/\(?[₹$€£]\)?/.test(c.text))) return null; // a data row, not a header
  return cols;
}

/** A second header line ("No." under "Sl", "Value" under "Taxable"): short, no digits, sits under header columns. */
function isHeaderContinuation(row: DocRow, cols: Column[]): boolean {
  return row.cells.length > 0 && row.cells.every((c) => c.text.length <= 20 && !/\d/.test(c.text)) &&
    row.cells.every((c) => cols.some((col) => overlap(c, col) > 0 || roleOf(c.text) !== null));
}

function overlap(a: { x0: number; x1: number }, b: { x0: number; x1: number }): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
}

function columnFor(cell: DocCell, cols: Column[], row: DocRow): number {
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

const TEXT_ROLES: Role[] = ["description", "uom"];

function looksNumeric(text: string): boolean {
  const t = text.trim();
  return parseAmount(t) != null || /^\d+(?:\.\d+)?\s*%$/.test(t) || parseQty(t).qty != null;
}

/**
 * Which column each cell of an item row belongs to. Printed numbers are usually right-aligned and drift from their
 * header's position, so position alone misplaces them; their ORDER does not drift. So: the row's number cells, left
 * to right, go to the number columns left to right, and its text cells to the text columns (extra text joins the
 * description). A code column (HSN, SKU) can hold numbers or text, so both readings are tried. Only when the counts
 * do not line up (a blank cell, two values merged) is each cell placed by position.
 */
function assignCells(row: DocRow, cols: Column[]): Partial<Record<Role, DocCell[]>> {
  const numericCells = row.cells.filter((c) => looksNumeric(c.text));
  const textCells = row.cells.filter((c) => !looksNumeric(c.text));
  for (const codeIsNumeric of [true, false]) {
    const isNumericCol = (c: Column) => !TEXT_ROLES.includes(c.role) && (c.role !== "code" || codeIsNumeric);
    const numericCols = cols.filter(isNumericCol);
    const textCols = cols.filter((c) => !isNumericCol(c));
    if (numericCells.length !== numericCols.length || textCells.length < textCols.length || textCols.length === 0) continue;
    const out: Partial<Record<Role, DocCell[]>> = {};
    numericCells.forEach((cell, i) => (out[numericCols[i].role] ??= []).push(cell));
    // text cells in order: one per text column, any extra text belongs to the description
    const extra = textCells.length - textCols.length;
    let t = 0;
    for (const col of textCols) {
      const take = col.role === "description" ? 1 + extra : 1;
      (out[col.role] ??= []).push(...textCells.slice(t, t + take));
      t += take;
    }
    return out;
  }
  const out: Partial<Record<Role, DocCell[]>> = {};
  for (const cell of row.cells) {
    const i = columnFor(cell, cols, row);
    if (i >= 0) (out[cols[i].role] ??= []).push(cell);
  }
  return out;
}

/** "500 Nos" -> 500 + "Nos"; "4.500" -> 4.5; "6.00 hrs" -> 6 + "hrs". */
export function parseQty(text: string): { qty: number | null; uom: string | null } {
  const m = text.trim().match(/^([\d,]*\.?\d+)\s*([A-Za-z][A-Za-z./]{0,9})?\.?$/);
  if (!m) return { qty: null, uom: null };
  return { qty: parseAmount(m[1]), uom: m[2] ?? null };
}

function percentOf(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

const TOTALS_LABEL = /^(?:sub\s*-?\s*total|total|grand\s*total|net\s*(?:total|payable|amount)|taxable\s*(?:value|amount)|amount\s*(?:payable|due|chargeable)|balance(?:\s*due)?|(?:[csi]|ut)?gst|vat|sales\s*tax|tax\b|cess|round|rounding|discount|less\b|shipping|freight|handling|packing|delivery\s*charges|courier|insurance)/i;
const SUMMARY_HEADER = /\b(?:hsn|sac)\b/i;

function isTotalsRow(row: DocRow): boolean {
  // the first cell with words in it: a totals row inside a Word/Excel table often starts with blank cells
  const first = row.cells.find((c) => /[A-Za-z]/.test(c.text))?.text ?? "";
  return TOTALS_LABEL.test(fixOcrWords(first.replace(/^[^A-Za-z]+/, "").toLowerCase())) && amountsIn(row.text).length > 0;
}

function isSummaryHeader(row: DocRow): boolean {
  return SUMMARY_HEADER.test(row.text) && /taxable/i.test(row.text) && !/\b(?:description|particulars|item)\b/i.test(row.text);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0002);

function netUnitPrice(amount: number, qty: number): number {
  const v = amount / qty;
  return Math.abs(v - round2(v)) < 0.00005 ? round2(v) : Math.round(v * 10000) / 10000;
}

interface ItemTable { lines: RuleLine[]; usedRows: Set<number>; endRow: number }

function readItemTable(rows: DocRow[]): ItemTable | null {
  const headerIndex = rows.findIndex((r) => headerColumns(r) !== null);
  if (headerIndex < 0) return null;
  let cols = headerColumns(rows[headerIndex])!;
  const used = new Set<number>([headerIndex]);
  let start = headerIndex + 1;
  while (start < rows.length && rows[start].page === rows[headerIndex].page && isHeaderContinuation(rows[start], cols)) {
    for (const c of rows[start].cells) {
      const i = cols.findIndex((col) => overlap(c, col) > 0);
      if (i >= 0) cols[i] = { ...cols[i], label: `${cols[i].label} ${c.text}`, role: roleOf(`${cols[i].label} ${c.text}`) ?? cols[i].role };
    }
    used.add(start++);
  }
  const has = (role: Role) => cols.some((c) => c.role === role);

  const lines: RuleLine[] = [];
  let lastItemRow = -1;
  let end = rows.length;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    if (headerColumns(row)) { used.add(r); cols = headerColumns(row)!; continue; } // the header repeated on the next page
    if (isTotalsRow(row) || isSummaryHeader(row) || /in\s*words|amount\s*chargeable/i.test(row.text)) { end = r; break; }

    const byRole = assignCells(row, cols);
    const text = (role: Role) => (byRole[role] ?? []).map((c) => c.text).join(" ").trim();
    const conf = row.cells.reduce<number | null>((m, c) => (c.conf == null ? m : Math.min(m ?? 1, c.conf)), null);

    let description = text("description");
    const qtyCell = parseQty(text("qty"));
    const rate = parseAmount(text("rate").replace(/\/\s*[A-Za-z]+$/, ""));
    const amountText = text("taxable") || text("amount") || (!has("amount") && !has("taxable") ? text("line_total") : "");
    const amount = parseAmount(amountText);
    const numbersInRow = amountsIn(row.text).length;

    if (!description && numbersInRow === 0) continue;
    if (description && qtyCell.qty == null && rate == null && amount == null) {
      // a wrapped description line under the previous item, or a note in the table
      const prev = lines[lines.length - 1];
      if (prev && r === lastItemRow + 1 && row.page === rows[lastItemRow].page && !/^(?:continued|page\s+\d)/i.test(description)) {
        prev.description = `${prev.description} ${description}`.trim();
        used.add(r);
        lastItemRow = r;
      }
      continue;
    }
    if (!description || !/[A-Za-z]{2}/.test(description)) continue;
    if (!has("serial")) description = description.replace(/^\d{1,3}[.)]?\s+(?=[A-Za-z])/, "");

    let qty = qtyCell.qty;
    let unitPrice = rate;
    let lineAmount = amount;
    const discountText = text("discount");
    const discountPct = discountText ? (percentOf(discountText) ?? (/%/.test(cols.find((c) => c.role === "discount")?.label ?? "") ? parseAmount(discountText) : null)) : null;
    let problem: string | null = null;

    if (qty == null && lineAmount != null && unitPrice == null) {
      qty = 1; // an amount-only row (a fee, a service): one of it at that amount
      unitPrice = lineAmount;
    } else if (qty != null && unitPrice == null && lineAmount != null) {
      unitPrice = netUnitPrice(lineAmount, qty);
    } else if (qty != null && unitPrice != null && lineAmount == null) {
      lineAmount = round2(qty * unitPrice);
    }
    if (qty == null || unitPrice == null || lineAmount == null || qty <= 0) {
      problem = `line "${description.slice(0, 40)}": could not read ${qty == null ? "the quantity" : unitPrice == null ? "the price" : "the amount"}`;
      lines.push({ description, quantity: qty ?? 0, unit_price: unitPrice ?? 0, uom: qtyCell.uom, amount: lineAmount, problem, conf });
      used.add(r);
      lastItemRow = r;
      continue;
    }

    const gross = qty * unitPrice;
    if (discountPct != null && discountPct > 0) {
      if (close(round2(gross * (1 - discountPct / 100)), lineAmount)) unitPrice = netUnitPrice(lineAmount, qty);
      else problem = `line "${description.slice(0, 40)}": ${qty} x ${unitPrice} less ${discountPct}% is not the amount ${lineAmount}`;
    } else if (!close(round2(gross), lineAmount)) {
      const taxPct = percentOf(text("tax_rate"));
      if (taxPct != null && close(round2(gross * (1 + taxPct / 100)), lineAmount)) {
        lineAmount = round2(gross); // the amount column includes the line's tax; the line is the pre-tax amount
      } else {
        problem = `line "${description.slice(0, 40)}": ${qty} x ${unitPrice} = ${round2(gross)} but the amount says ${lineAmount}`;
      }
    }
    lines.push({ description, quantity: qty, unit_price: unitPrice, uom: text("uom") || qtyCell.uom, amount: lineAmount, problem, conf });
    used.add(r);
    lastItemRow = r;
  }
  return lines.length > 0 ? { lines, usedRows: used, endRow: end } : null;
}

/** "Visiting cards - 1000 nos @ 1.20 = 1,200.00" and "Widget, 2 x 5.00 = 10.00": items written as sentences. */
const INLINE_ITEM = /^(?:\d{1,3}[.)]\s*)?(.+?)\s*[-–:,]\s*([\d,]*\.?\d+)\s*([A-Za-z]{1,8}\.?)?\s*(?:@|x|×)\s*(?:rs\.?|[₹$€£])?\s*([\d,]*\.?\d+)\s*(?:=|:)\s*(?:rs\.?|[₹$€£])?\s*([\d,]*\.?\d+)\s*$/i;

function readInlineItems(rows: DocRow[]): ItemTable | null {
  const lines: RuleLine[] = [];
  const used = new Set<number>();
  let end = rows.length;
  rows.forEach((row, r) => {
    const m = row.text.replace(/\s\|\s/g, " ").match(INLINE_ITEM);
    if (!m) return;
    const qty = parseAmount(m[2]), price = parseAmount(m[4]), amount = parseAmount(m[5]);
    if (qty == null || price == null || amount == null) return;
    const problem = close(round2(qty * price), amount) ? null : `line "${m[1].slice(0, 40)}": ${qty} x ${price} is not ${amount}`;
    lines.push({ description: m[1].trim(), quantity: qty, unit_price: price, uom: m[3] ?? null, amount, problem, conf: row.cells[0]?.conf ?? null });
    used.add(r);
    end = r + 1;
  });
  return lines.length > 0 ? { lines, usedRows: used, endRow: end } : null;
}

// ------------------------------------------------------------------------------------------------ labelled fields

const L = {
  // a bare "#" counts only when a value follows it ("# KCS-INV-00982", or "#KCS-INV-00982" as OCR often joins them)
  invoiceNo: /^(?:(?:(?:tax\s+)?invoice\s*(?:no\.?|number|num\.?|#|id)|inv\.?\s*(?:no\.?|#|number)|bill\s*(?:no\.?|number|#)|document\s*(?:no\.?|number)|receipt\s*(?:no\.?|number)|voucher\s*(?:no\.?|number))(?=[\s:#.]|$)|#(?=\s*[A-Z0-9]))/i,
  invoiceDate: /^(?:(?:invoice|bill|document|inv\.?)\s*date|date\s*of\s*(?:invoice|issue|bill)|issue\s*date|invoice\s*dt\.?)(?=[\s:.\-]|$)/i,
  date: /^(?:date|dated|dt\.?)(?=[\s:.\-]|$)/i,
  po: /^(?:p\.?\s*o\.?|purchase\s*order|buyer'?s?\s*order|customer\s*(?:po|order)|your\s*(?:order\s*)?ref(?:erence)?|order\s*(?:ref(?:erence)?|no\.?|number|#))(?:\s*(?:no\.?|number|#|ref\.?|reference))?(?!\s*date)(?=[\s:#.]|$)/i,
  due: /^(?:due\s*date|payment\s*due(?:\s*date)?|due\s*on)(?=[\s:.\-]|$)/i,
  vendor: /^(?:vendor(?:\s*name)?|supplier(?:\s*name)?|seller|sold\s*by|billed?\s*by|bill\s*from|from)(?=[\s:.\-]|$)/i,
  buyer: /^(?:bill(?:ed)?\s*to|buyer|ship(?:ped)?\s*to|consignee|customer|invoice\s*to|sold\s*to|deliver(?:y)?\s*to|recipient|to\s*[,:]|to$)/i,
};
const ANY_LABEL = [L.invoiceNo, L.invoiceDate, L.date, L.po, L.due, L.vendor, L.buyer, /^(?:terms|gstin|vat|pan|place\s*of\s*supply|state|delivery|dispatch|destination|mode|e-?mail|ph(?:one)?|mob(?:ile)?|tel|account|transport|consignee|balance\s*due)/i];

const isLabel = (text: string) => ANY_LABEL.some((re) => re.test(text.trim()));

interface Found { value: string; conf: number | null; row: number }

function* labelHits(rows: DocRow[], label: RegExp): Generator<{ r: number; c: number; rest: string }> {
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].cells;
    for (let c = 0; c < cells.length; c++) {
      const m = cells[c].text.match(label);
      if (m) yield { r, c, rest: cells[c].text.slice(m[0].length).replace(/^[\s:#.\-–—]+/, "").trim() };
    }
  }
}

/** The value for a label: in the same cell, in the next cell along the row, or printed just under the label. */
function valueFor(rows: DocRow[], hit: { r: number; c: number; rest: string }, accept: (s: string) => string | null): Found | null {
  const row = rows[hit.r];
  const cell = row.cells[hit.c];
  if (hit.rest) {
    const v = accept(hit.rest);
    if (v) return { value: v, conf: cell.conf, row: hit.r };
  }
  const next = row.cells[hit.c + 1];
  if (next && !isLabel(next.text)) {
    const v = accept(next.text);
    if (v) return { value: v, conf: next.conf, row: hit.r };
  }
  for (let r = hit.r + 1; r <= Math.min(hit.r + 2, rows.length - 1); r++) {
    if (rows[r].page !== row.page) break;
    const below = rows[r].positioned
      ? rows[r].cells.find((c) => overlap(c, cell) > 0 || Math.abs(c.x0 - cell.x0) < 25)
      : rows[r].cells[Math.min(hit.c, rows[r].cells.length - 1)];
    if (!below || isLabel(below.text)) continue;
    const v = accept(below.text);
    if (v) return { value: v, conf: below.conf, row: r };
  }
  return null;
}

function acceptId(text: string): string | null {
  const token = text.trim().split(/\s+/)[0]?.replace(/[.,;:]+$/, "") ?? "";
  if (token.length < 2 || token.length > 40 || !/\d/.test(token) || !/^[A-Za-z0-9][A-Za-z0-9\-/_.#]*$/.test(token)) return null;
  if (parseDate(token, "DMY")) return null;
  return token;
}

function first(rows: DocRow[], label: RegExp, accept: (s: string) => string | null, skip?: (r: number, c: number) => boolean): Found | null {
  for (const hit of labelHits(rows, label)) {
    if (skip?.(hit.r, hit.c)) continue;
    const found = valueFor(rows, hit, accept);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ vendor

const BOILERPLATE = /^(?:\(?(?:original|duplicate|triplicate)(?:\s+for\s+\w+)?\)?|(?:tax\s+|gst\s+|proforma\s+|commercial\s+)?invoice|bill(?:\s+of\s+supply)?|receipt|estimate|quotation|statement|credit\s+note|debit\s+note|page\s+\d+.*|this\s+is\s+a\s+computer.*|e\.?\s*&\s*o\.?\s*e\.?)$/i;
const CONTACT = /@|www\.|https?:|\b(?:gstin|pan|cin|fssai|vat|ph|phone|tel|mob(?:ile)?|fax|e-?mail)\b|\+?\d[\d\s().-]{7,}\d|\b(?:road|rd\.?|street|st\.|nagar|plot|floor|suite|sector|area|estate|lane|marg|district|unit\s+\d|building|park|india|state\s+name|code\s*:|pin)\b|\b\d{6}\b|\b[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}\b/i;
const LEGAL = /\b(?:ltd\.?|limited|llp|llc|pvt\.?|private|inc\.?|incorporated|co\.|company|corp(?:oration)?\.?|gmbh|plc|associates|traders|trading|industries|enterprises|supplies|supply|solutions|services|studio|works|agencies|electricals|controls|& co)\b/i;

function vendorFromRows(rows: DocRow[]): { name: string | null; from: RuleReading["vendor_from"]; conf: number | null; corroborated: boolean } {
  const labelled = first(rows, L.vendor, (s) => (/[A-Za-z]{2}/.test(s) && !isLabel(s) ? s.replace(/\s+/g, " ").trim() : null));

  let signature: string | null = null;
  let signatureConf: number | null = null;
  for (const row of rows) for (const c of row.cells) {
    const m = c.text.match(/^[Ff][Oo][Rr]\s+([A-Z][\w&.,'()\- ]{2,79}?)\s*[.:]?$/);
    if (m && /\s/.test(m[1]) && !/^(?:the|your|this|any|all|our)\b/i.test(m[1])) {
      signature = m[1].replace(/\s+/g, " ").trim();
      signatureConf = c.conf;
    }
  }

  // Letterhead: the first rows of page 1, above the bill-to block, the item table and the labelled fields.
  const buyerRow = rows.findIndex((r) => r.cells.some((c) => L.buyer.test(c.text)));
  const stop = Math.min(...[buyerRow, rows.findIndex((r) => headerColumns(r) !== null)].filter((i) => i >= 0), 14);
  const candidates: Array<{ text: string; height: number; conf: number | null }> = [];
  for (const row of rows.slice(0, stop)) {
    if (row.page !== rows[0]?.page) break;
    for (const c of row.cells) {
      const t = c.text.replace(/^(?:from|for)\s*:?\s*/i, "").replace(/\s+/g, " ").trim();
      if (t.length < 3 || t.length > 70 || !/[A-Za-z]{2}/.test(t) || BOILERPLATE.test(t) || CONTACT.test(t) || isLabel(t) || /\d{3,}/.test(t)) continue;
      candidates.push({ text: t, height: c.y1 - c.y0, conf: c.conf });
    }
  }
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  // A label or a signature says WHO the vendor is. For text read by OCR it does not prove the SPELLING (OCR drops
  // spaces: "Rohan PrintStudio"), so an OCR'd name is trusted only when it is printed twice, spelled the same.
  const spelledTwice = (name: string) => rows.filter((r) => words(r.text).includes(words(name))).length >= 2;
  if (signature) {
    const match = candidates.find((c) => words(c.text) === words(signature!) || words(c.text).includes(words(signature!)));
    const ocr = (match?.conf ?? signatureConf) != null;
    return { name: match?.text ?? signature, from: "signature", conf: match?.conf ?? signatureConf, corroborated: !ocr || match != null };
  }
  if (labelled) return { name: labelled.value, from: "label", conf: labelled.conf, corroborated: labelled.conf == null || spelledTwice(labelled.value) };
  const pick = candidates.find((c) => LEGAL.test(c.text)) ?? [...candidates].sort((a, b) => b.height - a.height)[0];
  if (!pick) return { name: null, from: null, conf: null, corroborated: false };
  // A letterhead name is trusted when something else backs it: it is printed again elsewhere on the document
  // ("make cheques payable to ..."), or, read from a born-digital PDF (no OCR), it carries a legal form (Ltd, LLP,
  // Inc, Co.). An OCR'd name printed once is not, however it looks: OCR can drop a space or a letter.
  // Printed again with the SAME spacing: two copies that agree only once spaces are removed ("ARJUNMEHTA&" vs
  // "Arjun Mehta &") are a sign of an OCR slip, not a confirmation.
  const spaced = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
  const elsewhere = rows.filter((r) => spaced(r.text).includes(spaced(pick.text))).length >= 2;
  const corroborated = elsewhere || (pick.conf == null && STRONG_LEGAL.test(pick.text));
  return { name: pick.text, from: "letterhead", conf: pick.conf, corroborated };
}

const STRONG_LEGAL = /\b(?:ltd|limited|llp|llc|pvt|private\s+limited|inc|incorporated|gmbh|plc|corp(?:oration)?|co)\b\.?|&\s*(?:co|associates)\b/i;

// ------------------------------------------------------------------------------------------------ totals

interface TotalLine { kind: "subtotal" | "tax" | "charge" | "discount" | "round" | "total"; label: string; amount: number; strong: boolean }

/** The usual OCR slips in the words of a totals label: "Totat"/"Tota1"/"T0tal" -> total, a 0 or 1 inside a word -> o / l. */
function fixOcrWords(t: string): string {
  return t
    .replace(/(?<=[a-z])0(?=[a-z])/g, "o")
    .replace(/(?<=[a-z])1(?=[a-z]|\b)/g, "l")
    .replace(/\bt[o0]ta[tl1i]\b/g, "total")
    .replace(/\bsub\s*-?\s*t[o0]ta[tl1i]\b/g, "subtotal");
}

function classifyTotal(label: string): TotalLine["kind"] | null {
  const t = fixOcrWords(label.toLowerCase().replace(/[:₹$€£]/g, " ").replace(/\s+/g, " ").trim());
  if (!t || /in\s*words|chargeable|total\s*(?:qty|quantity|items?|units?|pcs)|total\s*tax\s*amount|tax\s*amount\s*\(/.test(t)) return null;
  // a tax registration (GSTIN/UIN, VAT Reg No, PAN, company number) is an identifier, not a tax charged
  if (/\b(?:gstin|uin|reg(?:istration)?|regn|pan|cin|company\s*no|tax\s*id|vat\s*no)\b/.test(t)) return null;
  if (/\bround(?:ing|ed)?(?:\s*off)?\b/.test(t)) return "round";
  if (/\bdiscount\b|^less\b/.test(t)) return "discount";
  if (/\b(?:shipping|freight|handling|packing|forwarding|courier|transport(?:ation)?|insurance|postage|carriage|delivery\s*charges?)\b/.test(t)) return "charge";
  // the final amount, before the subtotal rule: "Net Payable" is a total, not a "Net ..." subtotal
  if (/\b(?:grand\s*total|net\s*payable|(?:total\s*)?amount\s*(?:payable|due)|total\s*(?:payable|due)|balance\s*due|invoice\s*total)\b/.test(t)) return "total";
  if (/^(?:sub\s*-?\s*total|net\s*total|total\s*net|taxable\s*(?:value|amount|total)|total\s*taxable(?:\s*(?:value|amount))?|total\s*(?:before|excl(?:uding)?\.?)\s*(?:tax|vat|gst)|amount\s*before\s*tax|net\s*amount|net)\b/.test(t)) return "subtotal";
  if (/(?:^|[^a-z])(?:[csi]|ut)?gst|\bvat\b|sales\s*tax|^tax\b|\btax\s*@|\bcess\b/.test(t) && !/\btotal\b/.test(t)) return "tax";
  if (/\b(?:grand\s*total|total|amount\s*(?:payable|due)|net\s*payable|balance(?:\s*due)?|invoice\s*total)\b/.test(t)) return "total";
  return null;
}

const SINGLE_CELL_TOTAL = /^([A-Za-z][A-Za-z .&()%/-]{1,40}?)\s*[:\-]?\s*((?:rs\.?|inr|[₹$€£])?\s*-?[\d,]+(?:\.\d{1,2})?)\s*(?:\/-)?$/i;

function readTotals(rows: DocRow[], skip: Set<number>): TotalLine[] {
  const out: TotalLine[] = [];
  let inSummary = false;
  rows.forEach((row, r) => {
    if (skip.has(r)) return;
    if (isSummaryHeader(row)) { inSummary = true; return; }
    if (inSummary) {
      if (/^total\b/i.test(row.cells[0]?.text ?? "")) inSummary = false;
      return;
    }
    // label = the row's words; amount = the right-most cell that is a plain amount. On a laid-out page the amount of a
    // totals line is always its own cell; a number inside a sentence ("Company No. 08812274") is not an amount.
    const amountCells = row.cells.filter((c) => parseAmount(c.text) != null && !/%/.test(c.text));
    const lastCell = amountCells[amountCells.length - 1];
    let amount: number | null;
    let label: string;
    if (row.positioned && (!lastCell || lastCell === row.cells[0])) {
      // One cell holding both: allowed only when the cell is exactly "<words>: <amount>" ("Total: Rs. 3,500.00")
      const m = row.cells.length === 1 ? row.cells[0].text.match(SINGLE_CELL_TOTAL) : null;
      if (!m) return;
      label = m[1];
      amount = parseAmount(m[2]);
    } else {
      amount = lastCell ? parseAmount(lastCell.text) : amountsIn(row.text.replace(/\d+(?:\.\d+)?\s*%/g, " ")).pop() ?? null;
      label = row.cells.filter((c) => c !== lastCell).map((c) => c.text).join(" ").replace(/[\d,.]+\s*$/, "").trim() || row.text;
    }
    if (amount == null) return;
    const kind = classifyTotal(label);
    if (!kind) return;
    out.push({ kind, label: label.replace(/\s+/g, " ").slice(0, 60), amount, strong: /grand|payable|due|balance|invoice\s*total/i.test(label) });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ all together

const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/;
const VAT_NO = /\bVAT\s*(?:Reg(?:istration)?\.?)?\s*(?:No\.?|Number)?\s*[:.]?\s*((?:GB|IE|DE|FR)?\s?\d{3}\s?\d{4}\s?\d{2}(?:\s?\d{3})?)/i;

export function readInvoiceRules(rows: DocRow[]): RuleReading {
  const text = documentText(rows);
  const problems: string[] = [];
  const currency = detectCurrency(text);
  const order: DateOrder = dateOrderFor(currency, text);
  const fieldConf: Record<string, number | null> = {};

  const table = readItemTable(rows) ?? readInlineItems(rows);
  const lines = table?.lines ?? [];
  if (!table) problems.push("line_items: no item table found");
  for (const l of lines) if (l.problem) problems.push(`line_items: ${l.problem}`);

  // labelled fields
  const invoiceNo = first(rows, L.invoiceNo, acceptId);
  if (invoiceNo) fieldConf.invoice_number = invoiceNo.conf;
  const po = first(rows, L.po, acceptId);
  if (po) fieldConf.po_reference = po.conf;

  const acceptDate = (s: string) => {
    const tok = s.match(DATE_TOKEN)?.[0];
    return tok && parseDate(tok, order) ? tok : null;
  };
  const sameRowAs = (re: RegExp) => (r: number, c: number) => rows[r].cells.slice(0, c).some((x) => re.test(x.text));
  const dateHit = first(rows, L.invoiceDate, acceptDate)
    ?? first(rows, L.date, acceptDate, (r, c) => sameRowAs(L.po)(r, c) || sameRowAs(L.due)(r, c) || /order|delivery|dispatch|due|po\b/i.test(rows[r].cells[c].text));
  const parsedDate = dateHit ? parseDate(dateHit.value, order) : null;
  const dueHit = first(rows, L.due, acceptDate);

  const vendor = vendorFromRows(rows);
  fieldConf.vendor_name = vendor.conf;
  const taxId = text.match(GSTIN)?.[0] ?? text.match(VAT_NO)?.[1]?.replace(/\s+/g, " ").trim() ?? null;

  // totals
  const totals = readTotals(rows, table?.usedRows ?? new Set());
  const lineSum = round2(lines.reduce((s, l) => s + (l.amount ?? l.quantity * l.unit_price), 0));
  const subtotals = totals.filter((t) => t.kind === "subtotal");
  const subtotal = subtotals.find((t) => close(t.amount, lineSum))?.amount ?? subtotals[0]?.amount ?? null;
  const taxLines = dedupe(totals.filter((t) => t.kind === "tax"));
  const charges = dedupe(totals.filter((t) => t.kind === "charge"));
  const discounts = dedupe(totals.filter((t) => t.kind === "discount"));
  const rounds = dedupe(totals.filter((t) => t.kind === "round"));
  const tax = taxLines.length ? round2(taxLines.reduce((s, t) => s + t.amount, 0)) : null;
  const discount = discounts.length ? round2(discounts.reduce((s, t) => s + Math.abs(t.amount), 0)) : null;
  const roundOff = rounds.length ? round2(rounds.reduce((s, t) => s + t.amount, 0)) : null;
  const chargeSum = round2(charges.reduce((s, t) => s + t.amount, 0));
  const expectedTotal = round2((subtotal ?? lineSum) + (tax ?? 0) + chargeSum - (discount ?? 0) + (roundOff ?? 0));
  const totalCandidates = totals.filter((t) => t.kind === "total");
  const total = totalCandidates.find((t) => close(t.amount, expectedTotal))?.amount
    ?? totalCandidates.find((t) => t.strong)?.amount
    ?? (totalCandidates.length ? Math.max(...totalCandidates.map((t) => t.amount)) : null);

  if (!vendor.name) problems.push("vendor_name: not found");
  if (!invoiceNo) problems.push("invoice_number: not found");
  if (!parsedDate) problems.push("invoice_date: not found or unreadable");
  if (total == null) problems.push("total: not found");

  return {
    vendor_name: vendor.name,
    vendor_from: vendor.from,
    vendor_corroborated: vendor.corroborated,
    vendor_tax_id: taxId,
    invoice_number: invoiceNo?.value ?? null,
    invoice_date: parsedDate?.iso ?? null,
    date_ambiguous: parsedDate?.ambiguous ?? false,
    due_date: dueHit ? parseDate(dueHit.value, order)?.iso ?? null : null,
    po_reference: po?.value ?? null,
    currency,
    line_items: lines,
    subtotal,
    tax,
    tax_lines: taxLines.map((t) => ({ label: t.label, amount: t.amount })),
    other_charges: charges.map((t) => ({ label: t.label, amount: t.amount })),
    discount,
    round_off: roundOff,
    total,
    field_conf: fieldConf,
    problems,
  };
}

function dedupe(lines: TotalLine[]): TotalLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = `${l.label.toLowerCase().replace(/[^a-z]/g, "")}:${l.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ shared with the PO reader

/** The item lines of any business document (an invoice or a purchase order): its item table, else "@ rate =" lines. */
export function readLines(rows: DocRow[]): { lines: RuleLine[]; problems: string[] } {
  const table = readItemTable(rows) ?? readInlineItems(rows);
  const lines = table?.lines ?? [];
  return { lines, problems: table ? lines.filter((l) => l.problem).map((l) => `line_items: ${l.problem}`) : ["line_items: no item table found"] };
}

/**
 * The value printed with a label (same cell, next cell, or under it), for the given label pattern and kind of value
 * (or a function that accepts or refuses a candidate). `label` is the label as printed ("GRN Date", "Ship Date").
 */
export function labelledValue(
  rows: DocRow[], label: RegExp, kind: "id" | "date" | "text" | ((s: string) => string | null), order: DateOrder = null,
): { value: string; conf: number | null; label: string } | null {
  const accept = typeof kind === "function" ? kind
    : kind === "id" ? acceptId
    : kind === "date" ? (s: string) => { const tok = s.match(DATE_TOKEN)?.[0]; return tok && parseDate(tok, order) ? tok : null; }
    : (s: string) => (/[A-Za-z]{2}/.test(s) && !isLabel(s) ? s.replace(/\s+/g, " ").trim() : null);
  for (const hit of labelHits(rows, label)) {
    const found = valueFor(rows, hit, accept);
    if (found) return { value: found.value, conf: found.conf, label: rows[hit.r].cells[hit.c].text.match(label)![0].trim() };
  }
  return null;
}

/** Whether a cell's text is a field label ("Invoice No.", "GSTIN", "Ship to"...), not a value. */
export const isFieldLabel = isLabel;

export const LABELS = L;
