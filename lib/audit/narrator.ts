import { explain, type ExplainResult } from "@/lib/explain";
import { getSql } from "@/db/client";

/**
 * Answers an auditor's question about one PBC request: the "ask why" mechanic (lib/explain.ts), run
 * over each linked invoice's recorded decisions, one answer per invoice.
 *
 * Bounded, because each invoice is its own AI call (30 s timeout, retried on 429/5xx): at most
 * MAX_INVOICES per question, at most CONCURRENCY calls in flight. Before, a request with 40 invoices
 * meant 40 calls one after another, minutes of waiting and the provider's free-tier quota gone.
 *
 * One invoice's failure (the provider refusing, a timeout) is reported on that invoice's entry and
 * logged, and the others still get their answers; nothing is dropped silently.
 */
export const MAX_INVOICES = 10;
const CONCURRENCY = 3;

export type PbcNarrativeResult =
  | (ExplainResult & { invoiceId: string; invoiceNumber: string | null })
  | { invoiceId: string; invoiceNumber: string | null; skipped: string }
  | { invoiceId: string; invoiceNumber: string | null; error: string };

export interface PbcNarrative {
  results: PbcNarrativeResult[];
  /** How many linked invoices were asked about (at most MAX_INVOICES), and how many the request has. */
  answeredFor: number;
  totalLinked: number;
}

/** Runs `work` over `items` with at most `limit` in flight; results keep the items' order. */
async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

export async function narratePbcResponse(requestId: string, question: string): Promise<PbcNarrative> {
  const sql = getSql();
  const [req] = await sql`SELECT linked_invoice_ids FROM pbc_requests WHERE id = ${requestId}`;
  if (!req) throw new Error(`narratePbcResponse: no pbc_requests row found with id '${requestId}'`);

  const linkedIds: string[] = (req.linked_invoice_ids ?? "").split(",").filter(Boolean);
  const asked = linkedIds.slice(0, MAX_INVOICES);
  const numbers = new Map<string, string>(
    asked.length ? (await sql`SELECT id, invoice_number FROM vendor_bills WHERE id = ANY(${asked})`).map((r: any) => [r.id, r.invoice_number]) : [],
  );

  const results = await mapBounded(asked, CONCURRENCY, async (invoiceId): Promise<PbcNarrativeResult> => {
    const invoiceNumber = numbers.get(invoiceId) ?? null;
    const [anchor] = await sql`SELECT id FROM decisions WHERE invoice_id = ${invoiceId} ORDER BY seq DESC LIMIT 1`;
    if (!anchor) return { invoiceId, invoiceNumber, skipped: "No decisions are recorded for this invoice yet." };
    try {
      return { ...(await explain(invoiceId, anchor.id, question)), invoiceId, invoiceNumber };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`narratePbcResponse: request ${requestId}, invoice ${invoiceId}: the explanation failed: ${message}`);
      return { invoiceId, invoiceNumber, error: message };
    }
  });

  return { results, answeredFor: asked.length, totalLinked: linkedIds.length };
}
