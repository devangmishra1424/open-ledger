import { getDocumentContent } from "@/lib/documents/store";
import { handle, HttpError } from "@/lib/http";

/**
 * GET /api/documents/:id/file: the original uploaded file, exactly as it was uploaded.
 *
 * Shown in the browser (inline) only for types a browser displays without running anything: PDF and plain raster
 * images. Everything else (Word, Excel, HTML, SVG, text...) is served as an attachment of type
 * application/octet-stream with nosniff, so an uploaded HTML or SVG file can never render inside VeriBook's own
 * origin. Pass ?download=1 to always download.
 */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

export const GET = handle("GET /api/documents/:id/file", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const doc = await getDocumentContent(id);
  if (!doc) throw new HttpError(404, `no document '${id}'`);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const inline = !download && INLINE_TYPES.has(doc.mediaType);
  const ascii = doc.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new Response(new Uint8Array(doc.content), {
    status: 200,
    headers: {
      "Content-Type": inline ? doc.mediaType : "application/octet-stream",
      "Content-Length": String(doc.content.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
});
