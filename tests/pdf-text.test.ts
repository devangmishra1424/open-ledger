import { describe, it, expect } from "vitest";
import { extractPdfText, isPdfDataUrl, MAX_PDF_BYTES } from "@/lib/pdf-text";
import { makePdfDataUrl, drawTableInvoice } from "./helpers/make-pdf";

describe("extractPdfText: a real PDF through the real library", () => {
  it("returns the text layer, one table row per line", async () => {
    const url = await makePdfDataUrl((doc) => drawTableInvoice(doc));
    expect(isPdfDataUrl(url)).toBe(true);
    const text = await extractPdfText(url);
    expect(text).toContain("Northwind Parts Ltd.");
    expect(text).toContain("Invoice No: NW-4471");
    expect(text).toMatch(/Industrial Bearing Set 12 \$145\.00 \$1,740\.00/);
    expect(text).toMatch(/Total \$2,311\.20/);
  });

  it("400 for bytes that are not a PDF", async () => {
    const url = "data:application/pdf;base64," + Buffer.from("this is not a pdf at all").toString("base64");
    await expect(extractPdfText(url)).rejects.toMatchObject({ status: 400 });
  });

  it("400 for an empty file and 413 for one over the cap", async () => {
    await expect(extractPdfText("data:application/pdf;base64,")).rejects.toMatchObject({ status: 400 });
    const big = "data:application/pdf;base64," + Buffer.alloc(MAX_PDF_BYTES + 1).toString("base64");
    await expect(extractPdfText(big)).rejects.toMatchObject({ status: 413 });
  });

  it("422 for a PDF with no text layer (a scan), saying there is no OCR", async () => {
    const blank = await makePdfDataUrl((doc) => { doc.rect(50, 50, 100, 100).stroke(); });
    await expect(extractPdfText(blank)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/no text layer.*no OCR/) });
  });
});
