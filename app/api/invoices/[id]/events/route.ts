import { pipelineEvents, type PipelineEvent } from "@/lib/pipeline/events";

/** GET /api/invoices/:id/events (SSE) — the exact ALGORITHMS.md §5 pattern, against the real pipelineEvents emitter. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const listener = (event: PipelineEvent) => controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      pipelineEvents.on(id, listener);
      req.signal.addEventListener("abort", () => pipelineEvents.off(id, listener));
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
