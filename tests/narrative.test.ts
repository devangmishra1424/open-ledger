import { describe, it, expect } from "vitest";
import { formatNarrative, plainText, splitSentences, tokenize } from "../frontend/src/lib/narrative";

/** The reading aid must never change what the text says. */

// Shaped like real recorded claims (an AI reviewer's run-on reasoning, an engine finding, a failure).
const SAMPLES = [
  `Verifier disagreed with the Investigator: I disagree with the Investigator's no-exception/auto-approve recommendation. The invoice line "matchedCount" is 1 and the line was matched on unitPrice=$17,710 = $17,710 (USD, exchangeRate 1). That's a $2,310 over-charge, +15.0% variance, far above the 2% (tolerancePct=0.02) allowed on the line. This is a price/unit-price variance exception (EXC-PRICE_VAR). At $17,710, EXC-PRICE_VAR maps to escalate_l2 per the tier table (upTo50000=escalate_l2), not auto_approve. Receipt dated 2026-10-08, invoice dated 2026-10-08.`,
  `EXC-CREDIT_MEMO: escalate_l1`,
  `Posted to the ledger, but payment did not go out: payment rail unreachable. Retry later; e.g. after the provider recovers. Total was 1,234.56 USD.`,
  `The AI provider's daily usage limit for openai/gpt-oss-120b was reached; it says to try again in 2m55.392s. This is a quota on the provider's free tier, not a fault with the invoice.`,
  `Amount 60000.00 is over the auto-approval limit of 50000.00`,
  `   lots   of    spaces\n\nand newlines. Second sentence here.   `,
];

describe("formatNarrative", () => {
  it("never drops or changes a word, on any sample", () => {
    for (const s of SAMPLES) {
      const normalised = s.replace(/\s+/g, " ").trim();
      expect(plainText(formatNarrative(s))).toBe(normalised);
    }
  });

  it("puts the conclusion first and breaks the rest into short paragraphs", () => {
    const n = formatNarrative(SAMPLES[0]);
    expect(n.label).toBe("Verifier disagreed with the Investigator");
    expect(n.lead.map((t) => t.text).join("")).toMatch(/^I disagree with the Investigator's no-exception\/auto-approve recommendation\.$/);
    expect(n.paragraphs.length).toBeGreaterThanOrEqual(2);
    for (const p of n.paragraphs) expect(p.map((t) => t.text).join("").length).toBeLessThan(420);
  });

  it("marks the keywords without removing them", () => {
    const kinds = (s: string) => tokenize(s).filter((t) => t.kind !== "text").map((t) => `${t.kind}:${t.text}`);
    expect(kinds("At $17,710, EXC-PRICE_VAR maps to escalate_l2, not auto_approve.")).toEqual(["money:$17,710", "code:EXC-PRICE_VAR", "action:escalate_l2", "action:auto_approve"]);
    expect(kinds("+15.0% variance on 2026-10-08")).toEqual(["percent:+15.0%", "date:2026-10-08"]);
    expect(kinds("the line unitPrice=$15,400 and tolerancePct=0.02")).toEqual(["field:unitPrice=$15,400", "field:tolerancePct=0.02"]);
    expect(kinds("Total was 1,234.56 USD")).toEqual(["money:1,234.56"]);
  });

  it("does not split inside decimals, amounts or abbreviations", () => {
    expect(splitSentences("The variance is 1.5% on $2,310.50. Next sentence.")).toEqual(["The variance is 1.5% on $2,310.50.", "Next sentence."]);
    expect(splitSentences("Retry later; e.g. after the provider recovers. Done.")).toEqual(["Retry later; e.g. after the provider recovers.", "Done."]);
  });

  it("leaves a short engine finding as just a lead line", () => {
    const n = formatNarrative("EXC-CREDIT_MEMO: escalate_l1");
    expect(n.label).toBeNull();
    expect(n.paragraphs).toEqual([]);
    expect(n.lead.map((t) => t.kind)).toEqual(["code", "text", "action"]);
  });

  it("copes with empty input", () => {
    expect(formatNarrative("   ")).toEqual({ label: null, lead: [], paragraphs: [] });
  });
});
