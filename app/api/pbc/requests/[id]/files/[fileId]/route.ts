import { getSql } from "@/db/client";
import { handle } from "@/lib/http";

/**
 * GET /api/pbc/requests/:id/files/:fileId — the attached file itself, as a download. Before this
 * route a file could be attached but never retrieved.
 *
 * Always served as an attachment of type application/octet-stream with nosniff, whatever type it was
 * uploaded with: an uploaded HTML or SVG file must never render inside VeriBook's own origin.
 */
export const GET = handle("GET /api/pbc/requests/:id/files/:fileId", async (_req, { params }: { params: Promise<{ id: string; fileId: string }> }) => {
  const { id, fileId } = await params;
  const [file] = await getSql()`SELECT filename, content_base64 FROM pbc_evidence_files WHERE id = ${fileId} AND pbc_request_id = ${id}`;
  if (!file) return Response.json({ error: `no file '${fileId}' on request '${id}'` }, { status: 404 });
  const bytes = Buffer.from(file.content_base64, "base64");
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, "_");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
