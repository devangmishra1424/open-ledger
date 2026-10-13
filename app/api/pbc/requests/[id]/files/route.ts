import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { handle, HttpError, optionalString, readJsonBody, requireString, reviewerName } from "@/lib/http";

/**
 * GET/POST /api/pbc/requests/:id/files — supporting files for one auditor request (a confirmation
 * letter, a bank statement). Downloaded through GET .../files/:fileId.
 *
 * Stored as base64 in Postgres, so the size is capped: 5 MB of file is about 6.7 MB of base64 in a
 * TEXT column, which is the most this design should hold (a real deployment would keep files in
 * object storage and only a pointer here).
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size of a base64 string, without decoding it. */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** A plain file name: no directories, no control characters (it is echoed back in a download header). */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new HttpError(400, "filename is not a usable file name");
  return cleaned;
}

export const GET = handle("GET /api/pbc/requests/:id/files", async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const rows = await getSql()`
    SELECT id, filename, content_type, uploaded_by, uploaded_at, length(content_base64) AS b64_len, right(content_base64, 2) AS b64_tail
    FROM pbc_evidence_files WHERE pbc_request_id = ${id} ORDER BY uploaded_at DESC`;
  return Response.json(rows.map((r: any) => ({
    id: r.id, filename: r.filename, contentType: r.content_type, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
    sizeBytes: Math.floor((Number(r.b64_len) * 3) / 4) - (r.b64_tail === "==" ? 2 : r.b64_tail?.endsWith("=") ? 1 : 0),
  })));
});

/** Body: { filename, contentBase64, contentType?, reviewerName }. The uploader is the signed-in account (or, with sign-in off, the typed name). */
export const POST = handle("POST /api/pbc/requests/:id/files", async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  const uploadedBy = reviewerName(body, req);
  const filename = cleanFilename(requireString(body, "filename", { max: 200 }));
  const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64.replace(/\s+/g, "") : "";
  if (!contentBase64) throw new HttpError(400, "contentBase64 is required");
  if (contentBase64.length % 4 !== 0 || !BASE64.test(contentBase64)) throw new HttpError(400, "contentBase64 is not valid base64");
  const size = base64Bytes(contentBase64);
  if (size > MAX_FILE_BYTES) throw new HttpError(413, `the file is ${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB`);
  const contentType = optionalString(body, "contentType", { max: 100 });
  const safeType = contentType && /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : null;

  const sql = getSql();
  const [request] = await sql`SELECT id, status FROM pbc_requests WHERE id = ${id}`;
  if (!request) return Response.json({ error: `no pbc_requests row found with id '${id}'` }, { status: 404 });
  // A closed request's evidence has been handed over; adding to it afterwards would change what was given.
  if (request.status === "accepted") throw new HttpError(409, "this request is closed: its evidence has been handed over, so nothing more can be attached");

  const fileId = randomUUID();
  await sql`
    INSERT INTO pbc_evidence_files (id, pbc_request_id, filename, content_type, content_base64, uploaded_by)
    VALUES (${fileId}, ${id}, ${filename}, ${safeType}, ${contentBase64}, ${uploadedBy})
  `;
  return Response.json({ success: true, id: fileId, filename, sizeBytes: size, uploadedBy }, { status: 201 });
});
