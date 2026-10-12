/**
 * Makes recorded text readable WITHOUT changing it. Claims written by the matching engine or an AI
 * reviewer arrive as one run-on paragraph full of codes, amounts and field names. This splits that
 * text into a short lead line and short paragraphs, and marks the keywords (exception codes, actions,
 * amounts, percentages, dates, field names) so the eye can find them.
 *
 * Lossless by construction: every character of the input words ends up in a token, in order. The
 * only thing dropped is repeated whitespace. tests/narrative.test.ts checks that on real samples.
 */

export type TokenKind = "text" | "code" | "action" | "date" | "percent" | "money" | "field";

export interface Token {
  kind: TokenKind;
  text: string;
}

export interface Narrative {
  /** A short "Label:" the text opened with ("Verifier disagreed with the Investigator"), if any. */
  label: string | null;
  /** The first sentence: the conclusion, shown prominently. */
  lead: Token[];
  /** The rest, in short paragraphs. */
  paragraphs: Token[][];
}

const PATTERNS: Array<[Exclude<TokenKind, "text">, string]> = [
  ["code", String.raw`\b(?:EXC-[A-Z_]+|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD)\b`],
  ["action", String.raw`\b(?:escalate_l1|escalate_l2|auto_approve|auto_reject|block_fraud_flag)\b`],
  ["date", String.raw`\b\d{4}-\d{2}-\d{2}\b`],
  ["percent", String.raw`[+-]?\d+(?:\.\d+)?%`],
  ["money", String.raw`[$€£₹]\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b`],
  // camelCase identifiers as the engine writes them (unitPrice, tolerancePct), with an optional =value
  ["field", String.raw`\b[a-z]+(?:[A-Z][a-z0-9]*)+(?:=(?:[$€£₹]?\d(?:[\d,]*\d)?(?:\.\d+)?|[A-Za-z_][\w-]*))?`],
];
const TOKEN_RE = new RegExp(PATTERNS.map(([, src], i) => `(?<k${i}>${src})`).join("|"), "g");

export function tokenize(sentence: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of sentence.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ kind: "text", text: sentence.slice(last, idx) });
    const which = PATTERNS.findIndex((_, i) => m.groups?.[`k${i}`] !== undefined);
    tokens.push({ kind: PATTERNS[which][0], text: m[0] });
    last = idx + m[0].length;
  }
  if (last < sentence.length) tokens.push({ kind: "text", text: sentence.slice(last) });
  return tokens;
}

const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|inc|ltd|no|approx|est|cf|st|dr|mr|mrs|ms)\.$/i;

/** Splits at sentence ends, but not inside decimals ("1.5"), amounts, or after common abbreviations. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?](\s+)(?=[A-Z0-9$€£₹"'(\[])/g)) {
    const end = (m.index ?? 0) + 1;
    if (ABBREVIATION.test(text.slice(start, end))) continue;
    sentences.push(text.slice(start, end).trim());
    start = end + m[1].length;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

const PARAGRAPH_SENTENCES = 2;
const PARAGRAPH_CHARS = 320;

export function formatNarrative(raw: string): Narrative {
  let text = raw.replace(/\s+/g, " ").trim();
  let label: string | null = null;
  const labelled = text.match(/^([A-Z][^:.]{3,70}):\s+(.{30,})$/);
  if (labelled) {
    label = labelled[1];
    text = labelled[2];
  }

  const sentences = splitSentences(text);
  if (sentences.length === 0) return { label, lead: [], paragraphs: [] };

  const [first, ...rest] = sentences;
  const paragraphs: Token[][] = [];
  let current: string[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) paragraphs.push(tokenize(current.join(" ")));
    current = [];
    chars = 0;
  };
  for (const s of rest) {
    if (current.length >= PARAGRAPH_SENTENCES || (chars > 0 && chars + s.length > PARAGRAPH_CHARS)) flush();
    current.push(s);
    chars += s.length;
  }
  flush();
  return { label, lead: tokenize(first), paragraphs };
}

/** Test/inspection helper: the words of a narrative, back as one string. */
export function plainText(n: Narrative): string {
  const join = (ts: Token[]) => ts.map((t) => t.text).join("");
  return [n.label ? `${n.label}:` : "", join(n.lead), ...n.paragraphs.map(join)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
