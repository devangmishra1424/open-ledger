import { getDocument } from "@/lib/documents/store";
import { handle, HttpError } from "@/lib/http";

/**
 * GET /api/documents/:id: what is known about one uploaded document, for the invoice page's "Source document"
 * panel: the file's details, how it was read (digital or OCR, its confidence, what was done to each page), the
 * fields read from it and how sure the reading was, and the invoice or PO it became. The file itself is
 * GET /api/documents/:id/file. The page layout (word positions) is not returned: it is large and only the
 * field reader needs it.
 */
export const GET = handle("GET /api/documents/:id", async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) throw new HttpError(404, `no document '${id}'`);
  const { reading, extraction, ...summary } = doc;
  return Response.json({
    ...summary,
    fileUrl: `/api/documents/${id}/file`,
    reading: {
      sourceKind: reading.source_kind, pageCount: reading.page_count, ocrUsed: reading.ocr_used, ocrConfidence: reading.ocr_confidence,
      preparation: reading.preparation, warnings: reading.warnings, timingMs: reading.timing_ms, reader: reading.reader,
      text: reading.layout_text || reading.markdown,
    },
    extraction,
  });
});
