import { buildFieldReport, REASON_WORDS } from "@/lib/evals/field";
import { FOUND_BY_EVALS } from "@/lib/evals/found-by-evals";
import { changeSince } from "@/lib/evals/report";
import { latestReport, listReports } from "@/lib/evals/store";
import { handle } from "@/lib/http";
import { qualityPeriod } from "./period";

/**
 * GET /api/quality?from=YYYY-MM-DD&to=YYYY-MM-DD — the Quality page: the field report for the period (computed now,
 * compared with the last saved field report), the saved reports (lab runs and field snapshots), and the log of bugs
 * that evaluation found. The period defaults to the last 30 days; 400 on a bad date or a period over a year.
 */
export const GET = handle("GET /api/quality", async (req) => {
  const { from, to } = qualityPeriod(new URL(req.url));
  const field = await buildFieldReport({ from, to });
  field.change = changeSince(await latestReport("field", "field"), field);
  const [saved, lab] = await Promise.all([listReports({ limit: 30 }), latestReport("lab", "rules")]);
  // Reason codes in words, so the page never shows a bare code.
  return Response.json({ field, saved, latestLab: lab ? { id: lab.id, report: lab.report } : null, foundByEvals: FOUND_BY_EVALS, reasonTitles: REASON_WORDS });
});
