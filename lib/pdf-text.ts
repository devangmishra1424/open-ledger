import { PDFParse } from "pdf-parse";
import { HttpError } from "@/lib/http";

export const DATA_URL_PREFIX = "data:application/pdf;base64,";
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** True for the data URL the frontend sends in place of the text when a PDF is uploaded. */
export function isPdfDataUrl(s: string): boolean {
  return s.startsWith(DATA_URL_PREFIX);
}

/**
 * The text layer of a PDF, for the documents that arrive as files (invoices, purchase orders).
 *
 * pdf-parse 2.x is a class (`new PDFParse({ data }).getText()`), not the callable function the 1.x
 * releases exported: this route called it as a function, so every PDF upload failed with "could not
 * read text" until tests/pdf-text.test.ts (a real PDF through the real library) caught it.
 *
 * 400 for bytes that are not a readable PDF, 413 for one over MAX_PDF_BYTES, 422 for a PDF with no
 * text layer (a scan: there is no OCR here).
 */
export async function extractPdfText(dataUrl: string): Promise<string> {
  const buffer = Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), "base64");
  if (buffer.length === 0) throw new HttpError(400, "the PDF is empty");
  if (buffer.length > MAX_PDF_BYTES) throw new HttpError(413, `PDF is too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`);

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text: string;
  try {
    text = (await parser.getText()).text;
  } catch (e) {
    console.error("pdf-text: could not parse the PDF:", e);
    throw new HttpError(400, "could not read this file as a PDF");
  } finally {
    await parser.destroy();
  }
  if (text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").trim() === "") {
    throw new HttpError(422, "this PDF has no text layer (is it a scan? there is no OCR here, so paste the text or type it in)");
  }
  return text;
}
