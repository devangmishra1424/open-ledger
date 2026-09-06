import { getSql } from "@/db/client";

/** GET /api/ecosystem — real vendor nodes (from vendors table) around a fixed Core/Bank/Blockchain anchor set. */
export async function GET() {
  const sql = getSql();
  const vendors = await sql`SELECT id, name, trust_tier FROM vendors ORDER BY created_at ASC LIMIT 8`;

  const nodes = [
    { id: "core", label: "VeriBook Core", type: "Core", x: 400, y: 220, color: "#a7c957", details: "Central orchestration engine running the real 7-stage agent pipeline." },
    { id: "bank", label: "Treasury / Payment Rail", type: "Bank", x: 640, y: 120, color: "#a7c957", details: "Where an approved bill's payment would be disbursed from." },
    { id: "chain", label: "Hash-Chain Ledger", type: "Blockchain", x: 640, y: 320, color: "#ffd60a", details: "The real, append-only decision hash chain — verified by GET /api/audit/verify." },
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
    nodes.push({
      id: v.id,
      label: v.name,
      type: "Vendor",
      x, y,
      color: v.trust_tier === "flagged" ? "#ff5757" : "#ffffff",
      details: `Trust tier: ${v.trust_tier}.`,
    });
    connections.push({ from: v.id, to: "core", label: "Invoice Stream" });
  });

  return Response.json({ nodes, connections });
}
