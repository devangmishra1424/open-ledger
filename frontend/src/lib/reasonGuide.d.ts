/** Types for reasonGuide.js, so TypeScript code (the root test suite) can import it. */
export interface ReasonGuideEntry {
  means: string;
  why: string;
  check: string[];
  usually: string;
  engine: string;
}
export const REASON_GUIDE: Record<string, ReasonGuideEntry>;
export const AUTO_APPROVED_GUIDE: { means: string; checks: string[] };
