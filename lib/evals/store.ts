import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { getSql } from "@/db/client";
import { REPORT_VERSION, type EvalReport, type ReportKind } from "./report";

/**
 * Saved reports (table eval_reports, migration 011). Every function takes the connection to use, defaulting to the
 * app's own: the lab run works in its own schema and saves its report into another one (the live demo's), so it
 * passes a second connection pinned there.
 */

type Sql = ReturnType<typeof postgres>;

export interface SavedReportSummary {
  id: string;
  kind: ReportKind;
  mode: EvalReport["mode"];
  verdict: EvalReport["verdict"];
  summary: string;
  periodFrom: string | null;
  periodTo: string | null;
  codeVersion: string | null;
  createdBy: string | null;
  createdAt: string;
}

const LIST_MAX = 100;

export async function saveReport(report: EvalReport, createdBy: string | null, sql: Sql = getSql()): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO eval_reports (id, kind, mode, verdict, summary, period_from, period_to, code_version, created_by, report)
    VALUES (${id}, ${report.kind}, ${report.mode}, ${report.verdict}, ${report.summary}, ${report.period?.from ?? null},
            ${report.period?.to ?? null}, ${report.codeVersion}, ${createdBy}, ${sql.json(report as never)})`;
  console.info(`eval report saved: ${id} (${report.kind}/${report.mode}, ${report.verdict})`);
  return id;
}

export async function listReports(opts: { kind?: ReportKind; limit?: number } = {}, sql: Sql = getSql()): Promise<SavedReportSummary[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 30)), LIST_MAX);
  const rows = opts.kind
    ? await sql`SELECT id, kind, mode, verdict, summary, period_from, period_to, code_version, created_by, created_at FROM eval_reports WHERE kind = ${opts.kind} ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`SELECT id, kind, mode, verdict, summary, period_from, period_to, code_version, created_by, created_at FROM eval_reports ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, mode: r.mode, verdict: r.verdict, summary: r.summary, periodFrom: r.period_from, periodTo: r.period_to,
    codeVersion: r.code_version, createdBy: r.created_by, createdAt: r.created_at,
  }));
}

/** A saved report, or null. A report saved by a newer layout than this code understands is refused, not half-shown. */
export async function getReport(id: string, sql: Sql = getSql()): Promise<{ summary: SavedReportSummary; report: EvalReport } | null> {
  const [row] = await sql`SELECT * FROM eval_reports WHERE id = ${id}`;
  if (!row) return null;
  const report = (typeof row.report === "string" ? JSON.parse(row.report) : row.report) as EvalReport;
  if (report.version !== REPORT_VERSION) throw new Error(`eval report ${id} has layout version ${report.version}; this code reads version ${REPORT_VERSION}`);
  return {
    summary: {
      id: row.id, kind: row.kind, mode: row.mode, verdict: row.verdict, summary: row.summary, periodFrom: row.period_from, periodTo: row.period_to,
      codeVersion: row.code_version, createdBy: row.created_by, createdAt: row.created_at,
    },
    report,
  };
}

/** The newest saved report of this kind and mode: what "change since last" compares with. */
export async function latestReport(kind: ReportKind, mode: EvalReport["mode"], sql: Sql = getSql()): Promise<{ id: string; generatedAt: string; report: EvalReport } | null> {
  const [row] = await sql`SELECT id FROM eval_reports WHERE kind = ${kind} AND mode = ${mode} ORDER BY created_at DESC LIMIT 1`;
  if (!row) return null;
  const saved = await getReport(row.id, sql);
  return saved ? { id: saved.summary.id, generatedAt: saved.report.generatedAt, report: saved.report } : null;
}
