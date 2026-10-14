import type { Reading } from "@/lib/documents/reader-client";

/**
 * A document as rows of positioned cells, whatever it came from:
 *  - a PDF, scan or photo: the reader's `layout` (each text line with its box, grouped into the page's visual rows);
 *  - a Word/Excel/HTML file or pasted text (no page positions): markdown table rows split into cells, other lines
 *    split on runs of spaces, tabs or " | ", with each cell's x set from its column index so that rows of one table
 *    still line up column by column.
 * Coordinates are 0-1000 across and down a page, top-left origin.
 */
export interface DocCell { text: string; x0: number; y0: number; x1: number; y1: number; conf: number | null }
export interface DocRow { index: number; page: number; cells: DocCell[]; text: string; positioned: boolean }

const SYNTHETIC_COL_WIDTH = 100;

function syntheticRow(cells: string[], index: number, y: number): DocRow {
  const out = cells.map((text, i) => ({ text, x0: i * SYNTHETIC_COL_WIDTH, x1: i * SYNTHETIC_COL_WIDTH + 90, y0: y, y1: y + 8, conf: null }));
  return { index, page: 1, cells: out, text: out.map((c) => c.text).join(" | "), positioned: false };
}

/** Rows from text with no positions (markdown or plain). */
export function rowsFromText(text: string): DocRow[] {
  const rows: DocRow[] = [];
  let y = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    y += 10;
    if (/^\|?\s*:?-{3,}/.test(line)) continue; // markdown table rule
    let cells: string[];
    if (line.startsWith("|")) {
      cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      // Docling repeats a merged cell's text across the columns it spans: keep one copy of a run
      cells = cells.filter((c, i) => i === 0 || c !== cells[i - 1] || c === "");
    } else {
      cells = line.split(/\t+| {2,}| \| /).map((c) => c.trim()).filter(Boolean);
    }
    cells = cells.map((c) => c.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "").trim());
    if (cells.every((c) => c === "")) continue;
    rows.push(syntheticRow(cells, rows.length, y));
  }
  return rows;
}

/**
 * A page's text cells grouped into printed lines. Two rules, both from how a printed line works:
 *  - a cell joins a line when its vertical middle falls inside that line's FIRST cell's band (comparing to the
 *    first cell, not to a band that grows as cells join, stops a chain of slightly offset cells from swallowing the
 *    lines below it, which happens on photos and skewed scans);
 *  - two cells that overlap horizontally by more than half the narrower one are never on the same line (one is
 *    printed under the other). A small overlap is just OCR drawing a box a little wide ("1" nicking the start of
 *    the description beside it) and does not count.
 */
export function stacked(a: { x0: number; x1: number }, b: { x0: number; x1: number }): boolean {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  return overlap > 0.5 * Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
}

export function groupIntoLines(cells: DocCell[]): DocCell[][] {
  const lines: Array<{ top: number; bottom: number; cells: DocCell[] }> = [];
  for (const cell of [...cells].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const mid = (cell.y0 + cell.y1) / 2;
    const line = lines.find((l) => mid >= l.top && mid <= l.bottom && !l.cells.some((c) => stacked(c, cell)));
    if (line) line.cells.push(cell);
    else lines.push({ top: cell.y0, bottom: cell.y1, cells: [cell] });
  }
  return lines
    .sort((a, b) => a.top + a.bottom - (b.top + b.bottom))
    .map((l) => l.cells.sort((a, b) => a.x0 - b.x0));
}

export function rowsFromReading(reading: Reading): DocRow[] {
  if (reading.layout && reading.layout.length > 0) {
    const rows: DocRow[] = [];
    for (const page of reading.layout) {
      const cells = page.rows.flat().map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text !== "");
      for (const line of groupIntoLines(cells)) {
        rows.push({ index: rows.length, page: page.page, cells: line, text: line.map((c) => c.text).join(" | "), positioned: true });
      }
    }
    if (rows.length > 0) return rows;
  }
  return rowsFromText(reading.markdown);
}

/** The text a person would read, row by row (for regexes over the whole document and for the AI reader). */
export function documentText(rows: DocRow[]): string {
  return rows.map((r) => r.text).join("\n");
}
