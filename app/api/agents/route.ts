import { getSql } from "@/db/client";
import { modelFor } from "@/lib/agent/llm";

/**
 * GET /api/agents — one row per pipeline stage, backed by real aggregates over the `decisions`
 * table. `avgSpeed` is measured (ended_at - started_at); `avgConfidence` is the mean confidence
 * the stage itself reported (null for stages that report none — it is NOT an accuracy figure);
 * `errorRate` is the share of this stage's runs that ended in an error. `model` is the model
 * the stage is configured to use right now (lib/agent/llm.ts), or says it is deterministic.
 */
const STAGE_META: Record<string, { name: string; role: string; description: string }> = {
  extract: {
    name: "Extraction Agent",
    role: "Line-Item & Header Extraction",
    description: "Reads invoice fields off a document: a deterministic template parse first, an LLM only when that is incomplete. Confidence comes from real checks (required fields present, lines add up to the subtotal, subtotal + tax equals the total).",
  },
  validate: {
    name: "Pre-Match Validator",
    role: "Deterministic Gate Checks",
    description: "Runs the six pre-match gates (readability, duplicate, vendor status, currency, invoice date, mandatory fields) before matching begins.",
  },
  match: {
    name: "3-Way Matching Engine",
    role: "PO / Receipt / Invoice Reconciliation",
    description: "Deterministically compares invoice lines against purchase order lines and goods receipts, raising every exception finding it detects.",
  },
  investigate: {
    name: "Investigator Agent",
    role: "Tool-Calling Evidence Gathering",
    description: "An LLM agent that calls real tools (vendor history, PO lookup, correction memory) to reach a grounded recommendation on flagged invoices.",
  },
  verify: {
    name: "Verifier Agent",
    role: "Second-Opinion Cross-Model Review",
    description: "An independent model that reviews the Investigator's conclusion on tier-2-eligible invoices before it reaches policy.",
  },
  policy: {
    name: "Policy & Compliance Engine",
    role: "Tiered Decision Matrix Evaluation",
    description: "Applies the dollar-threshold and precedence rules to the combined exception findings and produces the final routing action.",
  },
  audit: {
    name: "Audit & Posting Engine",
    role: "Journal Posting & Chain Sealing",
    description: "Posts the approval journal entry on auto-approve and writes the invoice's final, hash-chained decision record.",
  },
};

const MODEL_LABEL: Record<string, () => string> = {
  extract: () => `Template parser; ${modelFor("extractor")} when the template is incomplete`,
  investigate: () => modelFor("investigator"),
  verify: () => modelFor("verifier"),
};

const STAGE_ORDER = ["extract", "validate", "match", "investigate", "verify", "policy", "audit"];

export async function GET() {
  const sql = getSql();
  const rows = await sql`
    SELECT node_id,
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE action_taken = 'error')::int as errors,
      AVG(confidence) as avg_confidence,
      AVG(EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz)) * 1000) as avg_ms
    FROM decisions
    WHERE node_id = ANY(${STAGE_ORDER}) AND superseded_by_id IS NULL
    GROUP BY node_id
  `;
  const byNode = new Map(rows.map((r: any) => [r.node_id, r]));

  const agents = STAGE_ORDER.map((nodeId) => {
    const meta = STAGE_META[nodeId];
    const row = byNode.get(nodeId);
    const total = row?.total ?? 0;
    const avgConfidence = row?.avg_confidence != null ? Number(row.avg_confidence) : null;
    const avgMs = row?.avg_ms != null ? Number(row.avg_ms) : null;
    return {
      id: nodeId,
      name: meta.name,
      role: meta.role,
      status: total > 0 ? "Active" : "Idle",
      model: MODEL_LABEL[nodeId]?.() ?? "Deterministic engine",
      description: meta.description,
      avgConfidence: avgConfidence != null ? Math.round(avgConfidence * 1000) / 10 : null,
      errorRate: total > 0 ? Math.round(((row?.errors ?? 0) / total) * 1000) / 10 : null,
      avgSpeed: avgMs != null ? `${Math.round(avgMs)}ms` : "—",
      totalProcessed: total,
    };
  });

  return Response.json(agents);
}
