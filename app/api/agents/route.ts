import { getSql } from "@/db/client";

/**
 * GET /api/agents — the frontend's `mockAgents` shape, backed by real aggregates over the real
 * `decisions` table (one row per real pipeline stage that has ever actually run) rather than
 * the frontend's fictional fixed 5-agent roster. `avgSpeed` is genuinely measured
 * (ended_at - started_at) per decision, not a made-up number.
 */
const STAGE_META: Record<string, { name: string; role: string; description: string }> = {
  extract: {
    name: "Extraction Agent",
    role: "Line-Item & Header Extraction",
    description: "Parses invoice line items, header fields, and totals — a deterministic parse for structured intake, an LLM pass for OCR'd documents.",
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

const STAGE_ORDER = ["extract", "validate", "match", "investigate", "verify", "policy", "audit"];

export async function GET() {
  const sql = getSql();
  const rows = await sql`
    SELECT node_id,
      COUNT(*)::int as total,
      AVG(confidence) as avg_confidence,
      AVG(EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz)) * 1000) as avg_ms
    FROM decisions
    WHERE node_id = ANY(${STAGE_ORDER})
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
      model: nodeId === "investigate" || nodeId === "verify" ? (process.env.OPENAI_MODEL || "gpt-5-nano") : "Deterministic Engine",
      description: meta.description,
      accuracy: avgConfidence != null ? Math.round(avgConfidence * 1000) / 10 : 100,
      avgSpeed: avgMs != null ? `${Math.round(avgMs)}ms` : "—",
      totalProcessed: total,
    };
  });

  return Response.json(agents);
}
