import { HttpError } from "@/lib/http";

/**
 * The client for VeriBook's document reader (docreader/, a Python service running Docling with OCR). It turns a
 * file of any supported kind (PDF with or without a text layer, a phone photo or other image, Word, Excel,
 * PowerPoint, HTML) into text and tables; lib/documents/fields.ts then reads invoice fields out of that.
 *
 * DOCREADER_URL (default http://127.0.0.1:8090) is where it listens. If it is not running, uploads fail with
 * 503 and say so: there is deliberately no fallback to a weaker reader, because a scan read by nothing would
 * look like an empty invoice instead of a broken dependency.
 */

export interface ReaderTable { page: number | null; columns: string[]; rows: string[][] }

export interface Reading {
  filename: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  /** digital_pdf | scanned_pdf | image | office | web; "text" for pasted text (never sent to the reader). */
  source_kind: string;
  page_count: number;
  ocr_used: boolean;
  /** 0-1 from the OCR engine; null when no OCR ran. */
  ocr_confidence: number | null;
  layout_confidence: number | null;
  table_confidence: number | null;
  /** The whole document as markdown; tables stay tables. */
  markdown: string;
  tables: ReaderTable[];
  /** Each page's text lines with their positions (0-1000, top-left origin), grouped into visual rows. Empty for
   *  Word/Excel/HTML (no page positions) and for pasted text. See lib/documents/layout.ts. */
  layout: Array<{ page: number; rows: Array<Array<{ text: string; x0: number; y0: number; x1: number; y1: number; conf: number | null }>> }>;
  /** The same rows as text: one row per line, cells joined by " | ". */
  layout_text: string;
  /** What was done to each page before OCR (perspective flattened, skew straightened, ...). */
  preparation: Array<{ page: number; steps: string[] }>;
  warnings: string[];
  timing_ms: { prepare?: number; convert?: number; total?: number };
  reader: Record<string, string>;
}

export const SUPPORTED_UPLOAD_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".csv", ".md"];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** A scanned multi-page document on a small CPU machine takes tens of seconds; the reader itself stops at 150 s. */
const READ_TIMEOUT_MS = 180_000;

function readerUrl(): string {
  return (process.env.DOCREADER_URL?.trim() || "http://127.0.0.1:8090").replace(/\/+$/, "");
}

/** A Reading for pasted or plain-text input: no reader involved, nothing was OCR'd. */
export function textReading(text: string, filename = "pasted text"): Reading {
  return {
    filename, media_type: "text/plain", sha256: "", byte_size: Buffer.byteLength(text), source_kind: "text", page_count: 1,
    ocr_used: false, ocr_confidence: null, layout_confidence: null, table_confidence: null,
    markdown: text, tables: [], layout: [], layout_text: "", preparation: [], warnings: [], timing_ms: {}, reader: {},
  };
}

/**
 * Sends one file to the reader. Throws HttpError with the reader's own status and message for a document it
 * refused (400 damaged, 413 too large, 415 unsupported, 422 nothing readable, 503 busy), 503 when the reader is
 * not reachable, 504 when it took too long.
 */
export async function readDocument(file: { bytes: Uint8Array; filename: string; mediaType?: string }): Promise<Reading> {
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mediaType || "application/octet-stream" }), file.filename);

  let res: Response;
  try {
    res = await fetch(`${readerUrl()}/read`, { method: "POST", body: form, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") {
      throw new HttpError(504, `the document reader took longer than ${READ_TIMEOUT_MS / 1000} s on ${file.filename}; try a smaller file or fewer pages`);
    }
    console.error(`readDocument: the document reader at ${readerUrl()} is not reachable: ${err.message}`);
    throw new HttpError(503, "the document reader is not running, so documents cannot be read right now (start it with `npm run reader`)");
  }

  const body = (await res.json().catch(() => null)) as (Reading & { error?: string }) | null;
  if (!res.ok) {
    const message = body?.error ?? `the document reader failed (HTTP ${res.status})`;
    console.error(`readDocument: ${file.filename}: reader answered ${res.status}: ${message}`);
    throw new HttpError(res.status >= 500 && res.status !== 503 ? 502 : res.status, message);
  }
  if (!body || typeof body.markdown !== "string" || !Array.isArray(body.tables)) {
    throw new HttpError(502, "the document reader returned an answer VeriBook does not understand");
  }
  return body;
}
