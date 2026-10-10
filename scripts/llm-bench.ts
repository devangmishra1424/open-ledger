/**
 * Benchmarks candidate models for the Investigator on a clean three-way match: how often does a
 * run finish with a valid submission, how long does it take, how many times did the loop have to
 * re-sample an invalid tool call, and what confidence does it report.
 *
 *   npx tsx --env-file=.env scripts/llm-bench.ts [runsPerModel=6] [model ...]
 *
 * Runs in its own schema (veribook_bench) — it creates fixtures, so it must never touch `public`.
 * Numbers go in the README only when they come from here.
 */
process.env.DB_SCHEMA = process.env.DB_SCHEMA || "veribook_bench";

import { randomUUID } from "node:crypto";
import { getSql, activeSchema } from "../db/client";
import { migrateSchema } from "../db/migrate-lib";
import { runMatchStage } from "../lib/pipeline/match-stage";
import { investigate } from "../lib/agent/investigator";

const DEFAULT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

async function makeCleanBill(): Promise<{ billId: string; detail: unknown }> {
  const sql = getSql();
  const v = randomUUID(), po = randomUUID(), pl = randomUUID(), gr = randomUUID(), bill = randomUUID();
  await sql`INSERT INTO vendors (id, name, trust_tier) VALUES (${v}, ${"Bench Vendor " + v.slice(0, 4)}, 'trusted')`;
  await sql`INSERT INTO purchase_orders (id, po_number, vendor_id, order_date, status) VALUES (${po}, ${"BENCH-PO-" + v.slice(0, 6)}, ${v}, '2026-09-01', 'open')`;
  await sql`INSERT INTO purchase_order_lines (id, po_id, line_number, description, uom, qty_ordered, unit_price) VALUES (${pl}, ${po}, 1, 'Widget', 'each', 50, 10)`;
  await sql`INSERT INTO goods_receipts (id, po_id, receipt_date, condition) VALUES (${gr}, ${po}, '2026-09-10', 'accepted')`;
  await sql`INSERT INTO goods_receipt_lines (id, goods_receipt_id, po_line_id, qty_received) VALUES (${randomUUID()}, ${gr}, ${pl}, 50)`;
  await sql`INSERT INTO vendor_bills (id, vendor_id, po_id, invoice_number, invoice_date, subtotal, total_amount) VALUES (${bill}, ${v}, ${po}, ${"BENCH-" + bill.slice(0, 6)}, '2026-09-15', 500, 500)`;
  await sql`INSERT INTO vendor_bill_lines (id, vendor_bill_id, description, qty_invoiced, unit_price, gl_account_id) VALUES (${randomUUID()}, ${bill}, 'Widget', 50, 10, '6000')`;
  return { billId: bill, detail: (await runMatchStage(bill)).detail };
}

async function main() {
  const args = process.argv.slice(2);
  const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 6);
  const models = args.filter((a) => !/^\d+$/.test(a));
  const candidates = models.length > 0 ? models : DEFAULT_MODELS;

  const sql = getSql();
  console.log(`schema: ${activeSchema()}  runs/model: ${runs}`);
  await migrateSchema(sql);
  const { billId, detail } = await makeCleanBill();

  const originalWarn = console.warn;
  console.log("\nmodel".padEnd(26) + "ok".padEnd(8) + "median s".padEnd(10) + "max s".padEnd(8) + "resamples".padEnd(11) + "conf (min-max)");
  for (const model of candidates) {
    process.env.INVESTIGATOR_MODEL = model;
    let resamples = 0;
    console.warn = (...a: unknown[]) => { if (String(a[0]).includes("re-sampling")) resamples++; else originalWarn(...a); };
    const times: number[] = [];
    const confs: number[] = [];
    let ok = 0;
    const failures: string[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      try {
        const r = await investigate(billId, detail);
        ok++;
        confs.push(r.submission.confidence);
        times.push((Date.now() - t0) / 1000);
      } catch (e) {
        failures.push((e instanceof Error ? e.message : String(e)).slice(0, 120));
      }
    }
    console.warn = originalWarn;
    times.sort((a, b) => a - b);
    const med = times.length ? times[Math.floor(times.length / 2)].toFixed(1) : "-";
    const max = times.length ? times[times.length - 1].toFixed(1) : "-";
    const conf = confs.length ? `${Math.min(...confs).toFixed(2)}-${Math.max(...confs).toFixed(2)}` : "-";
    console.log(model.padEnd(26) + `${ok}/${runs}`.padEnd(8) + med.padEnd(10) + max.padEnd(8) + String(resamples).padEnd(11) + conf);
    for (const f of failures) console.log(`    failure: ${f}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
