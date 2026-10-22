/**
 * The lab run: every labelled case in eval/decisions/cases.ts through the real pipeline, scored against the written
 * policy, with the money rules checked in the database afterwards.
 *
 *   npx tsx --env-file=.env eval/decisions/run.ts                         rules only (no AI key needed; what CI runs)
 *   npx tsx --env-file=.env eval/decisions/run.ts --ai                    with the AI review, to measure what it changes
 *   npx tsx --env-file=.env eval/decisions/run.ts --save-to veribook_demo also save the report for the Quality page
 *
 * It works in its own schema (DB_SCHEMA, default veribook_eval), rebuilt empty at the start of every run, and refuses
 * any schema not ending in _eval or _test: the cases create invoices and payments. Exits 1 unless every target is met,
 * so it can gate a merge. The report is also written to eval/decisions/out/.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import postgres from "postgres";

process.env.DB_SCHEMA ||= "veribook_eval";

const args = process.argv.slice(2);
const ai = args.includes("--ai");
const saveTo = valueOf("--save-to");
const only = valueOf("--only");

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function codeVersion(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8", timeout: 5000 }).trim() || null;
  } catch (e) {
    // A deploy without git metadata: the report says the version is unknown rather than guessing one.
    console.warn(`code version unknown (git rev-parse failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return null;
  }
}

async function main() {
  const { getSql } = await import("@/db/client");
  const { migrateSchema } = await import("@/db/migrate-lib");
  const { assertLabSchema, runLab } = await import("@/lib/evals/lab");
  const { changeSince } = await import("@/lib/evals/report");
  const { latestReport, saveReport } = await import("@/lib/evals/store");
  const { CASES } = await import("./cases");

  if (ai && !process.env.GROQ_API_KEY) throw new Error("--ai needs GROQ_API_KEY: without it every AI review fails and the run measures nothing about the AI");
  if (!ai) process.env.GROQ_API_KEY = ""; // rules only: nothing in the run may reach the AI, even by a path not yet known
  const schema = assertLabSchema();
  const sql = getSql();
  await migrateSchema(sql);
  console.log(`Lab run in schema ${schema}, ${ai ? "rules + AI review" : "rules only"}.\n`);

  const cases = only ? CASES.filter((c) => only.split(",").includes(c.id)) : CASES;
  if (cases.length === 0) throw new Error(`--only ${only} matches no case`);
  const report = await runLab({ cases, ai, codeVersion: codeVersion(), log: (l) => console.log(l) });

  let target: ReturnType<typeof postgres> | null = null;
  if (saveTo) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(saveTo)) throw new Error(`--save-to '${saveTo}' is not a schema name`);
    target = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2, connect_timeout: 10, connection: { search_path: saveTo } });
    report.change = changeSince(await latestReport("lab", report.mode, target), report);
  }

  const outDir = path.join(process.cwd(), "eval", "decisions", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `lab-${report.mode === "rules" ? "rules" : "ai"}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\n${report.verdict.toUpperCase()}: ${report.summary}`);
  for (const t of report.targets) console.log(`  ${t.met === null ? "-" : t.met ? "ok" : "MISSED"}  ${t.label}: ${t.actual} (target ${t.target})`);
  console.log("\nBy operation:");
  for (const o of report.operations) {
    const score = o.correct === null ? "not scored"
      : o.caught && o.letThrough ? `stopped ${o.caught.n}/${o.caught.of} it should stop, let through ${o.letThrough.n}/${o.letThrough.of}`
      : `${o.correct}/${o.judged} ${o.scoredAs ?? "right"}`;
    console.log(`  ${o.label.padEnd(38)} ${score}${o.p95Ms !== null ? `, p95 ${o.p95Ms} ms` : ""}`);
  }
  console.log("\nMoney rules:");
  for (const r of report.money.rules) console.log(`  ${r.broken === 0 ? "ok" : `BROKEN x${r.broken}`}  ${r.rule}`);
  if (report.failures.length) {
    console.log("\nFailures:");
    for (const f of report.failures) console.log(`  [${f.kind}] ${f.id}: expected ${f.expected}; got ${f.got}`);
  }
  console.log(`\nReport: ${path.relative(process.cwd(), outFile)}`);

  if (target) {
    const id = await saveReport(report, "lab run", target);
    console.log(`Saved to ${saveTo}.eval_reports as ${id}.`);
    await target.end({ timeout: 5 });
  }
  await sql.end({ timeout: 5 });
  process.exitCode = report.verdict === "pass" ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 2;
});
