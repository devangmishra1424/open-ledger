import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";

/** GET/POST /api/pbc/requests/:id/files — real audit-evidence file attachments for one PBC request. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = getSql();
  const rows = await sql`SELECT id, filename, content_type, uploaded_by, uploaded_at FROM pbc_evidence_files WHERE pbc_request_id = ${id} ORDER BY uploaded_at DESC`;
  return Response.json(rows.map((r: any) => ({
    id: r.id, filename: r.filename, contentType: r.content_type, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  })));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = getSql();

  const requestRows = await sql`SELECT id FROM pbc_requests WHERE id = ${id}`;
  if (requestRows.length === 0) return Response.json({ error: `no pbc_requests row found with id '${id}'` }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const filename: string = body.filename ?? "";
  const contentBase64: string = body.contentBase64 ?? "";
  if (!filename || !contentBase64) {
    return Response.json({ error: "filename and contentBase64 are both required" }, { status: 400 });
  }

  const fileId = randomUUID();
  await sql`
    INSERT INTO pbc_evidence_files (id, pbc_request_id, filename, content_type, content_base64, uploaded_by)
    VALUES (${fileId}, ${id}, ${filename}, ${body.contentType ?? null}, ${contentBase64}, ${body.uploadedBy ?? "demo-reviewer"})
  `;

  return Response.json({ success: true, id: fileId, filename }, { status: 201 });
}
