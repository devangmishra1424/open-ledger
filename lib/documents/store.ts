import { createHash, randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import type { Reading } from "@/lib/documents/reader-client";

/**
 * The uploaded files behind invoices and purchase orders (table source_documents): the original bytes, what the
 * reader made of them, and the fields read from them. A file is stored when it is read, before anyone saves the
 * invoice, so the review screen can show it; it is linked to the invoice or PO when that is saved.
 *
 * The same file uploaded again (same SHA-256, same purpose) is not stored twice: the earlier record is returned,
 * with the invoice it became if it was saved, so the person is told instead of the invoice being entered twice.
 */

export type DocumentPurpose = "invoice" | "purchase_order";

export interface StoredDocumentSummary {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  purpose: DocumentPurpose;
  sourceKind: string;
  pageCount: number | null;
  ocrUsed: boolean;
  ocrConfidence: number | null;
  uploadedBy: string | null;
  uploadedAt: string;
  /** The invoice or PO this file became, once saved. */
  invoiceId: string | null;
  purchaseOrderId: string | null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function summary(row: any): StoredDocumentSummary {
  return {
    id: row.id, filename: row.filename, mediaType: row.media_type, byteSize: row.byte_size, purpose: row.purpose,
    sourceKind: row.source_kind, pageCount: row.page_count, ocrUsed: row.ocr_used,
    ocrConfidence: row.ocr_confidence == null ? null : Number(row.ocr_confidence),
    uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at, invoiceId: row.invoice_id ?? null, purchaseOrderId: row.po_id ?? null,
  };
}

const SUMMARY_COLUMNS = `d.id, d.filename, d.media_type, d.byte_size, d.purpose, d.source_kind, d.page_count, d.ocr_used, d.ocr_confidence,
  d.uploaded_by, d.uploaded_at,
  (SELECT b.id FROM vendor_bills b WHERE b.source_document_id = d.id LIMIT 1) AS invoice_id,
  (SELECT p.id FROM purchase_orders p WHERE p.source_document_id = d.id LIMIT 1) AS po_id`;

/** An earlier upload of exactly this file for this purpose, or null. */
export async function findByHash(hash: string, purpose: DocumentPurpose): Promise<(StoredDocumentSummary & { reading: Reading; extraction: unknown }) | null> {
  const rows = await getSql().unsafe(
    `SELECT ${SUMMARY_COLUMNS}, d.reading, d.extraction FROM source_documents d WHERE d.sha256 = $1 AND d.purpose = $2 ORDER BY d.uploaded_at LIMIT 1`,
    [hash, purpose],
  );
  return rows[0] ? { ...summary(rows[0]), reading: rows[0].reading, extraction: rows[0].extraction } : null;
}

export async function saveDocument(input: {
  bytes: Uint8Array; filename: string; mediaType: string; purpose: DocumentPurpose; reading: Reading; extraction: unknown; uploadedBy: string | null;
}): Promise<string> {
  const id = randomUUID();
  const r = input.reading;
  await getSql()`
    INSERT INTO source_documents (id, sha256, filename, media_type, byte_size, content, purpose, source_kind, page_count, ocr_used, ocr_confidence, reading, extraction, uploaded_by)
    VALUES (${id}, ${sha256(input.bytes)}, ${input.filename.slice(0, 200)}, ${input.mediaType}, ${input.bytes.byteLength}, ${Buffer.from(input.bytes)},
            ${input.purpose}, ${r.source_kind}, ${r.page_count ?? null}, ${r.ocr_used}, ${r.ocr_confidence ?? null},
            ${getSql().json(r as any)}, ${getSql().json((input.extraction ?? null) as any)}, ${input.uploadedBy})`;
  return id;
}

export async function getDocument(id: string): Promise<(StoredDocumentSummary & { reading: Reading; extraction: unknown }) | null> {
  const rows = await getSql().unsafe(`SELECT ${SUMMARY_COLUMNS}, d.reading, d.extraction FROM source_documents d WHERE d.id = $1`, [id]);
  return rows[0] ? { ...summary(rows[0]), reading: rows[0].reading, extraction: rows[0].extraction } : null;
}

export async function getDocumentContent(id: string): Promise<{ filename: string; mediaType: string; content: Buffer } | null> {
  const [row] = await getSql()`SELECT filename, media_type, content FROM source_documents WHERE id = ${id}`;
  return row ? { filename: row.filename, mediaType: row.media_type, content: Buffer.from(row.content) } : null;
}
