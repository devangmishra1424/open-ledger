import { buildFieldReport } from "@/lib/evals/field";
import { changeSince } from "@/lib/evals/report";
import { latestReport, listReports, saveReport } from "@/lib/evals/store";
import { handle, HttpError, readJsonBody, sessionUser } from "@/lib/http";
import { qualityPeriod } from "../period";

/**
 * GET  /api/quality/reports?kind=lab|field   saved reports, newest first (summaries only)
 * POST /api/quality/reports {from, to}        computes the field report for the period and saves it as a snapshot,
 *                                             so later reports can say what changed. Lab reports are saved by the
 *                                             lab run itself (eval/decisions/run.ts --save-to).
 */
export const GET = handle("GET /api/quality/reports", async (req) => {
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind !== null && kind !== "lab" && kind !== "field") throw new HttpError(400, "kind must be lab or field");
  return Response.json({ reports: await listReports({ kind: kind ?? undefined, limit: 50 }) });
});

export const POST = handle("POST /api/quality/reports", async (req) => {
  const { from, to } = qualityPeriod(await readJsonBody(req));
  const report = await buildFieldReport({ from, to });
  report.change = changeSince(await latestReport("field", "field"), report);
  const id = await saveReport(report, sessionUser(req)?.name ?? null);
  return Response.json({ id, verdict: report.verdict, summary: report.summary }, { status: 201 });
});
