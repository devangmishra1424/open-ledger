/**
 * Reading numbers, dates and currencies the way they are actually printed on invoices from different countries.
 * Pure functions; every one returns null rather than guess when the text does not say clearly.
 */

// ------------------------------------------------------------------------------------------------ amounts

/**
 * A money amount or quantity: "1,04,135.00" (Indian grouping), "1,377.45", "₹ 12,434.00", "$1,230.90",
 * "£247.97", "Rs. 3,500/-", "(45.00)" (negative), "-0.35", "0.34". Null for anything that is not one number.
 * European "1.234,56" is NOT accepted: a dot-thousands, comma-decimal amount would be read 1000x wrong by any
 * reader that does not know the locale, so it is refused here and the field stays empty for a person.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let t = raw.trim()
    .replace(/^(?:rs\.?|inr|usd|gbp|eur|sgd|aud|cad|us\$|s\$|a\$|c\$|[₹$€£])\s*/i, "")
    .replace(/\s*(?:\/-|inr|usd|gbp|eur|only)$/i, "")
    .replace(/^(?:rs\.?|[₹$€£])\s*/i, "")
    .trim();
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1).trim();
  }
  if (/^[-−–]/.test(t)) {
    negative = true;
    t = t.slice(1).trim();
  } else if (t.startsWith("+")) {
    t = t.slice(1).trim();
  }
  t = t.replace(/^(?:rs\.?|[₹$€£])\s*/i, "");
  // digits with optional comma grouping (western 3-3-3 or Indian 2-2-3) and an optional decimal part
  if (!/^\d{1,3}(?:,\d{2,3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Every number-looking token in a string, in order (for reading a row of cells or a "label 1,234.00" line). */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\(?[-−–]?\s*(?:rs\.?\s*|[₹$€£]\s*)?\d[\d,]*(?:\.\d+)?\)?/gi)) {
    const n = parseAmount(m[0].replace(/\s+/g, "").replace(/,+$/, ""));
    if (n != null) out.push(n);
  }
  return out;
}

/** True when `value` appears printed in `text` in any usual form (1,04,135.00 / 104,135.00 / 104135 / 104135.0). */
export function amountPrintedIn(value: number, text: string): boolean {
  const target = Math.round(value * 100);
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = parseAmount(m[0].replace(/,+$/, ""));
    if (n != null && Math.round(n * 100) === target) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ currency

/** The invoice's currency from explicit codes and symbols, most specific first. Null when the document does not say. */
export function detectCurrency(text: string): string | null {
  const explicit = text.match(/\bcurrency\s*[:\-]?\s*([A-Z]{3})\b/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/₹|\bINR\b|\bRs\.?\s?\d|\brupees?\b|\bGSTIN\b/i.test(text)) return "INR";
  if (/\bS\$|\bSGD\b/.test(text)) return "SGD";
  if (/\bA\$|\bAUD\b/.test(text)) return "AUD";
  if (/\bC\$|\bCAD\b/.test(text)) return "CAD";
  if (/€|\bEUR\b/.test(text)) return "EUR";
  if (/£|\bGBP\b/.test(text)) return "GBP";
  if (/\bUSD\b|US\$|\$\s?\d/.test(text)) return "USD";
  return null;
}

// ------------------------------------------------------------------------------------------------ dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Which way round an all-number date is written where the document comes from. */
export type DateOrder = "DMY" | "MDY" | null;

/** India, the UK, Europe, Singapore and Australia write day first; the US writes month first. Null when unknown. */
export function dateOrderFor(currency: string | null, text = ""): DateOrder {
  if (currency === "USD" && !/\bGSTIN\b|\bVAT\b/i.test(text)) return "MDY";
  if (currency && ["INR", "GBP", "EUR", "SGD", "AUD"].includes(currency)) return "DMY";
  if (/\bGSTIN\b|\bVAT\s+Reg/i.test(text)) return "DMY";
  return null;
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null; // 31 Feb rolled over
  return d.toISOString().slice(0, 10);
}

export interface ParsedDate { iso: string; ambiguous: boolean }

/**
 * An ISO date from how invoices print dates: "2026-09-12", "12-Sep-2026", "12 Sep 2026", "Sep 12, 2026",
 * "3rd October 2026", "08.10.2026", "05/10/2026", "11-10-26". An all-number date where both parts could be the
 * month is read by `order` (from the document's country); with no order it is returned with ambiguous=true,
 * read day-first, so the caller flags it instead of trusting it.
 */
export function parseDate(raw: string | null | undefined, order: DateOrder): ParsedDate | null {
  if (!raw) return null;
  const t = raw.trim().replace(/(\d)(?:st|nd|rd|th)(?=\b|[A-Z])/gi, "$1").replace(/\s+/g, " ").replace(/,/g, "");
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const v = iso(+m[1], +m[2], +m[3]);
    return v ? { iso: v, ambiguous: false } : null;
  }
  // the separators either side of a month name may be missing: OCR drops spaces ("3rd October2026", "12Sep 2026")
  m = t.match(/^(\d{1,2})[\s\-/.]?([A-Za-z]{3,9})\.?(?:[\s\-/.]+(\d{2,4})|(\d{4}))$/);
  if (m) {
    m[3] = m[3] ?? m[4];
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const v = mon >= 0 ? iso(+m[3], mon + 1, +m[1]) : null;
    return v ? { iso: v, ambiguous: false } : null;
  }
  m = t.match(/^([A-Za-z]{3,9})\.?\s(\d{1,2})\s(\d{4})$/);
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const v = mon >= 0 ? iso(+m[3], mon + 1, +m[2]) : null;
    return v ? { iso: v, ambiguous: false } : null;
  }
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b <= 12) return wrap(iso(y, b, a), false);
    if (b > 12 && a <= 12) return wrap(iso(y, a, b), false);
    if (a === b) return wrap(iso(y, a, b), false);
    if (order === "MDY") return wrap(iso(y, a, b), false);
    if (order === "DMY") return wrap(iso(y, b, a), false);
    return wrap(iso(y, b, a), true);
  }
  return null;
}

function wrap(v: string | null, ambiguous: boolean): ParsedDate | null {
  return v ? { iso: v, ambiguous } : null;
}

/** The date-looking substrings of a line, for "Dated 12-Sep-2026" or "Date: 3rd October 2026 | Due: ...". */
export const DATE_TOKEN = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}(?:st|nd|rd|th)?[\s\-/.]?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?(?:[\s\-/.,]+\d{2,4}|\d{4})|[A-Za-z]{3,9}\.?\s\d{1,2}(?:st|nd|rd|th)?,?\s\d{4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/gi;
