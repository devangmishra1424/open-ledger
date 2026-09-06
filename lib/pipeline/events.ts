import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for pipeline stage events (ENGINE.md §4). No external broker needed at
 * hackathon-demo scale (a few dozen invoices, one Node process). Keyed by invoice id so
 * `GET /api/invoices/:id/events` can subscribe to just one invoice's stream; a global "*"
 * channel powers the dashboard's aggregate counters.
 */
export const pipelineEvents = new EventEmitter();
// Many concurrent SSE subscribers (one per open invoice detail page, plus the dashboard's
// global listener) is expected usage, not a leak — the default limit-10 warning doesn't apply.
pipelineEvents.setMaxListeners(0);

export interface PipelineEvent {
  invoiceId: string;
  nodeId: string;
  decisionId: string;
  actionTaken?: string;
  at: string;
}

export function publishPipelineEvent(event: PipelineEvent): void {
  pipelineEvents.emit(event.invoiceId, event);
  pipelineEvents.emit("*", event);
}
