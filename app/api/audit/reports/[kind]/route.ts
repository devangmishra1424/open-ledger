import { ageingReport, overridesReport, receivedNotInvoicedReport, toCsv } from "@/lib/audit/reports";
import { handle, HttpError } from "@/lib/http";

/**
 * GET /api/audit/reports/:kind — the auditor's period reports (lib/audit/reports.ts):
 *   overrides?from=YYYY-MM-DD&to=YYYY-MM-DD    every decision a person made, with warning signs
 *   ageing?asOf=YYYY-MM-DD                     approved invoices not yet paid, by days past due, tied to the ledger
 *   received-not-invoiced?asOf=YYYY-MM-DD      goods accepted but not billed by that date (cut-off)
 * Add &format=csv for a spreadsheet. Dates default to today (and, for `from`, 90 days back). 400 on a bad date.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

function dateParam(url: URL, key: string, fallback: string): string {
  const v = url.searchParams.get(key) ?? fallback;
  if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${key} must be a date as YYYY-MM-DD`);
  return v;
}

export const GET = handle("GET /api/audit/reports/:kind", async (req, { params }: { params: Promise<{ kind: string }> }) => {
  const { kind } = await params;
  const url = new URL(req.url);
  const csv = url.searchParams.get("format") === "csv";
  let body: { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
  if (kind === "overrides") {
    const to = dateParam(url, "to", today());
    const from = dateParam(url, "from", new Date(Date.parse(to) - 90 * 864e5).toISOString().slice(0, 10));
    if (from > to) throw new HttpError(400, "from must be on or before to");
    body = { from, to, rows: (await overridesReport({ from, to })) as unknown as Array<Record<string, unknown>> };
  } else if (kind === "ageing") {
    body = (await ageingReport({ asOf: dateParam(url, "asOf", today()) })) as unknown as typeof body;
  } else if (kind === "received-not-invoiced") {
    body = (await receivedNotInvoicedReport({ asOf: dateParam(url, "asOf", today()) })) as unknown as typeof body;
  } else {
    throw new HttpError(404, `no report '${kind}' (overrides, ageing, received-not-invoiced)`);
  }
  if (!csv) return Response.json(body);
  return new Response(toCsv(body.rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="veribook-${kind}-${today()}.csv"` },
  });
});
