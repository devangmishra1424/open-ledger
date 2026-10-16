import { getSql } from "@/db/client";

/** What each trust tier means for how this vendor's invoices are treated (lib/pipeline/match-stage.ts, lib/ledger/bank-change-review.ts). */
const TIER_WORDS: Record<string, string> = {
  trusted: "Trusted: an established vendor. The only kind whose very small non-PO bills (up to 100) may pass without a person.",
  new: "New: little or no history yet. The rules treat it like any vendor, and the AI reviewer weighs the missing history.",
  flagged: "Flagged: a bank-detail change was not confirmed by the vendor, so payments to it stay blocked.",
};

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GET /api/ecosystem — real vendor nodes (from vendors table) around a fixed Core / payment rail / ledger anchor set. */
export async function GET() {
  const sql = getSql();
  // Bounded (at most 8 vendors drawn), with each vendor's own invoice counts so its node can say what it means for the queue.
  const vendors = await sql`
    SELECT v.id, v.name, v.trust_tier, v.bank_account_changed_at,
      COUNT(b.id)::int AS invoices,
      COUNT(b.id) FILTER (WHERE b.status = 'exception')::int AS waiting,
      COALESCE(SUM(b.total_amount) FILTER (WHERE b.status IN ('approved', 'posted', 'paid')), 0) AS cleared
    FROM vendors v LEFT JOIN vendor_bills b ON b.vendor_id = v.id
    GROUP BY v.id
    ORDER BY v.created_at ASC
    LIMIT 8`;

  const nodes = [
    { id: "core", label: "VeriBook Core", type: "Core", x: 400, y: 220, color: "#a7c957", details: "The seven-step pipeline every invoice goes through: read it, basic checks, three-way match, AI review, a second AI check on serious cases, the approval rules, then post and record. Rules decide; AI can only make a decision stricter. See Pipeline for how each step is performing." },
    { id: "bank", label: "Payment Rail (simulated)", type: "Bank", x: 640, y: 120, color: "#a7c957", details: "Where approved invoices are paid. Simulated here: each payment gets a reference and is posted to the ledger, but no money moves. Nothing reaches it without an approval, automatic or by a person." },
    { id: "chain", label: "Hash-Chained Decision Ledger", type: "Ledger", x: 640, y: 320, color: "#ffd60a", details: "Every decision, automatic or human, is written here and chained to the one before it with SHA-256, so changing any past record breaks every record after it. Check it on the Audit page. A tamper-evident log, not a blockchain." },
  ];
  const connections = [
    { from: "core", to: "bank", label: "Payment Instruction" },
    { from: "core", to: "chain", label: "Decision Hash Commit" },
  ];

  const n = vendors.length;
  vendors.forEach((v: any, i: number) => {
    // Simple arc on the left side of the core node, spaced evenly for however many real vendors exist.
    const angle = n > 1 ? (-0.6 + (i / (n - 1)) * 1.2) : 0;
    const radius = 260;
    const x = Math.round(400 - Math.cos(angle) * radius);
    const y = Math.round(220 + Math.sin(angle) * radius * 0.85);
    const counts = v.invoices === 0
      ? "No invoices yet."
      : `${v.invoices} invoice${v.invoices === 1 ? "" : "s"}${v.waiting > 0 ? `, ${v.waiting} waiting on a person` : ""}; ${Number(v.cleared) > 0 ? `${money(Number(v.cleared))} approved so far` : "nothing approved yet"}.`;
    const bank = v.bank_account_changed_at ? ` Bank details changed on ${String(v.bank_account_changed_at).slice(0, 10)}; while a change is unconfirmed, every invoice from this vendor is held.` : "";
    nodes.push({
      id: v.id,
      label: v.name,
      type: "Vendor",
      x, y,
      color: v.trust_tier === "flagged" ? "#ff5757" : "#ffffff",
      details: `${TIER_WORDS[v.trust_tier] ?? `Trust tier: ${v.trust_tier}.`} ${counts}${bank}`,
    });
    connections.push({ from: v.id, to: "core", label: "Invoice Stream" });
  });

  return Response.json({ nodes, connections });
}
