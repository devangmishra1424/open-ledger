/** Types for labels.js, so TypeScript code (the root test suite) can import it. */
export interface DecisionWords {
  nodeId: string;
  actionTaken?: string | null;
  actor?: string | null;
  model?: string | null;
}
export const STAGE_HELP: Record<string, string>;
export function normalizeAction(action: string | null | undefined): string | null | undefined;
export function actionWords(action: string | null | undefined): string;
export function outcomeWords(decision: DecisionWords, invoice?: { invoiceType?: string }): string;
export function actorWords(decision: DecisionWords): string;
export const STATE_LABEL: Record<string, string>;
export function formatMoney(amount: number, currency?: string): string;
export function timeAgo(iso: string, now?: number): string;
export function shortHash(hash: string | null | undefined): string;
export function groundingNote(answer: { grounded: boolean; citedDecisionIds: string[] }): string;
