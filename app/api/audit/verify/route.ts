import { getAllDecisionsInOrder, toChainableRecord } from "@/lib/ledger/decisions";
import { verifyChain } from "@/lib/ledger/hash-chain";

/** GET /api/audit/verify — the whole GLOBAL hash chain, recomputed from scratch every call (ENGINE.md §5 / INTEGRATION.md). */
export async function GET() {
  const all = await getAllDecisionsInOrder();
  const result = verifyChain(all.map(toChainableRecord));
  return Response.json(result);
}
