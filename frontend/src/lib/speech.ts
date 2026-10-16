/**
 * Speech in and out for the "ask about this invoice" box, using what the browser already provides: SpeechRecognition to hear a
 * question and speechSynthesis to read the answer. No server route, no model, no new dependency.
 *
 * Everything here is plain TypeScript with its browser objects passed in, so it runs under tests with fakes. The React hook
 * (useSpeech.js) only supplies the real `window` objects.
 *
 * What it is NOT: a replacement for typing. Speech recognition exists in Chrome and Edge (which send the audio to the browser
 * vendor's speech service) and is missing in Firefox and most of Safari; any recogniser can mishear. Typing always works, the
 * question that was understood is shown next to the answer, and the feature only ever reads: a misheard word can produce a
 * wrong answer, never an approval or a payment.
 */

// ---------------------------------------------------------------------------------------------------------------------
// What gets read aloud
// ---------------------------------------------------------------------------------------------------------------------
// Special characters are built from their code points: written out they are invisible or look like a plain hyphen or space.
const cp = (...codes: number[]) => String.fromCharCode(...codes);
const NO_BREAK_SPACES = cp(0xa0, 0x2007, 0x2009, 0x202f);

const UUID_SRC = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
// One record id with whatever label the model put in front of it ("see decision <id>", "ids: <id>"), and runs of them joined by
// commas, "and" or "or". The label goes with the id: otherwise "see decision" is read out with nothing after it.
const ID_LABEL = String.raw`(?:(?:see|per)\s+)?(?:decision[_ ]?ids?|decisions?|records?|ids?)?\s*[:#]?\s*`;
const ID_ONE = `${ID_LABEL}<?${UUID_SRC}>?`;
const ID_JOIN = String.raw`\s*(?:[,;&]|\band\b|\bor\b)(?:\s*(?:\band\b|\bor\b))?\s*`; // "," ";" "and" "or" and ", and"
const ID_RUN = new RegExp(String.raw`${ID_ONE}(?:${ID_JOIN}${ID_ONE})*`, "gi");
const EMPTY_BRACKETS = /[([]\s*[-,;:]*\s*[)\]]/g;
const BRACKET_LEADING_JUNK = /([([])\s*[-,;:]+\s*/g;
// a long hash; needs a hex letter in it so a 16-digit account number is never mistaken for one
const LONG_HEX = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi;
const MARKDOWN_CODE = /```[\s\S]*?```/g;

// Reason codes and action names, with an optional "a"/"an" in front so the article can follow the words that replace the code.
const CODE_SRC = String.raw`EXC-[A-Z0-9]+(?:[-_][A-Z0-9]+)*|R99_AGENT_ERROR|CLEAN_MATCH|POLICY_LIMIT|INVESTIGATOR_HOLD`;
const ACTION_SRC = "escalate_l1|escalate_l2|auto_approve|auto_reject|block_fraud_flag";
const TERM = new RegExp(String.raw`\b(?:([Aa]n?)\s+)?(${CODE_SRC}|${ACTION_SRC})\b`, "g");
// Not the on-screen labels ("Sent to a reviewer (level 2)"): those are written to stand alone, these have to fit inside the model's sentence.
const ACTION_PHRASE: Record<string, string> = {
  escalate_l1: "level 1 escalation",
  escalate_l2: "level 2 escalation",
  auto_approve: "automatic approval",
  auto_reject: "automatic rejection",
  block_fraud_flag: "fraud flag block",
};
const CODE_WORDS: Record<string, string> = { var: "variance", rcv: "receipt", qty: "quantity", po: "purchase order", uom: "unit of measure", tax: "tax" };

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONEY = /([$€£₹])\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)/g;
const CODE_THEN_AMOUNT = /\b(USD|EUR|GBP|INR)\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)/g;
const CURRENCY_CODE = /\b(USD|EUR|GBP|INR)\b/g;
const PERCENT = /(\d)\s?%/g;
// camelCase field names, optionally with =value ("tolerancePct=0.02")
const FIELD_TOKEN = /\b([a-z]+(?:[A-Z][a-z0-9]*)+)(?:=(\d(?:[\d,]*\d)?(?:\.\d+)?|[A-Za-z_][\w-]*))?/g;

const CURRENCY_SIGN: Record<string, string> = { $: "dollars", "€": "euros", "£": "pounds", "₹": "rupees" };
const CURRENCY_NAME: Record<string, string> = { USD: "US dollars", EUR: "euros", GBP: "pounds", INR: "rupees" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Domain abbreviations a speech engine would spell out or run together.
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bPOs\b/g, "purchase orders"],
  [/\bPO\b/g, "purchase order"],
  [/\bGRN\b/g, "goods receipt"],
  [/\bAP\b/g, "accounts payable"],
  [/\bUoM\b/gi, "unit of measure"],
];
// Symbols an engine skips or reads oddly.
const SYMBOLS: Array<[RegExp, string]> = [
  [/≈/g, " about "],
  [/≥/g, " at least "],
  [/≤/g, " at most "],
  [/≠/g, " not equal to "],
  [/→/g, " to "],
  [/×/g, " times "],
  [/±/g, " plus or minus "],
  [/…/g, "."],
  [/&/g, " and "],
];
const EN_EM_DASH = cp(0x2013, 0x2014);
const RANGE_DASH = new RegExp(String.raw`(\d)${cp(0x2013)}(?=\d)`, "g");
const SPOKEN_PAUSE_DASH = new RegExp(String.raw`\s*[${EN_EM_DASH}]\s*`, "g");
const OTHER_HYPHENS = new RegExp(`[${cp(0x2010, 0x2011, 0x2012, 0x2015)}]`, "g");
const MINUS_BEFORE_DIGIT = new RegExp(String.raw`${cp(0x2212)}(?=\d)`, "g");
const DIGIT_GROUP_SPACE = new RegExp(String.raw`(\d)[${NO_BREAK_SPACES}](?=\d{3}(?!\d))`, "g");
const ANY_NO_BREAK_SPACE = new RegExp(`[${NO_BREAK_SPACES}]`, "g");

/** "EXC-PRICE_VAR" -> "price variance" (used when the screen's plain-language name for a code is not known) */
function humanizeCode(code: string): string {
  return code
    .replace(/^EXC-/, "")
    .replace(/^R99_/, "")
    .split(/[-_]/)
    .map((w) => CODE_WORDS[w.toLowerCase()] ?? w.toLowerCase())
    .join(" ");
}

/** "unitPrice" -> "unit price", "upTo50000" -> "up to 50000", "tolerancePct" -> "tolerance percent" */
function splitCamel(word: string): string {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .toLowerCase()
    .replace(/\bpct\b/, "percent");
}

/** The plain name for a code. Models sometimes write "EXC-FRAUD-BANK" for "EXC-FRAUD_BANK", so both spellings are tried. */
function codeName(code: string, reasonNames: Record<string, string>): string {
  const underscored = `EXC-${code.replace(/^EXC-/, "").replace(/-/g, "_")}`;
  return reasonNames[code] ?? reasonNames[underscored] ?? humanizeCode(code);
}

/** "a" or "an" to suit the word that follows ("a unit", "an invoice"), keeping the capital if the original had one. */
function articleFor(original: string, next: string): string {
  const word = /^(?!uni|use|eu)[aeiou]/i.test(next) ? "an" : "a";
  return original.startsWith("A") ? `A${word.slice(1)}` : word;
}

export interface SpeakableOptions {
  /** Plain-language names for exception codes, the same map the screen uses. */
  reasonNames?: Record<string, string>;
}

/**
 * The answer as it should sound. The text on screen is written to be read by eye (record ids, exception codes, camelCase field
 * names, symbols); read aloud those would be a string of letters and digits, so they are removed or put into words. Only the
 * wording changes: no figure is rounded or dropped.
 */
export function speakableText(text: string, { reasonNames = {} }: SpeakableOptions = {}): string {
  if (typeof text !== "string") return "";
  // Characters first: models write "EXC" + non-breaking hyphen + "PRICE_VAR", and some locales group digits with a no-break space
  // ("17 710"). Match on plain characters, read a digit group as one number, and read en/em dashes as a pause.
  let t = text
    .replace(DIGIT_GROUP_SPACE, "$1,")
    .replace(ANY_NO_BREAK_SPACE, " ")
    .replace(RANGE_DASH, "$1 to ")
    .replace(SPOKEN_PAUSE_DASH, ", ")
    .replace(MINUS_BEFORE_DIGIT, "minus ")
    .replace(OTHER_HYPHENS, "-")
    .replace(/ - /g, ", ");
  // markdown the engine would read as punctuation; underscores are NOT touched here, they are part of codes like EXC-PRICE_VAR
  t = t.replace(MARKDOWN_CODE, " ").replace(/[*`#]+/g, " ").replace(/^\s*>\s?/gm, "").replace(/^\s*[-•]\s+/gm, ". ");
  t = t.replace(ID_RUN, " ").replace(EMPTY_BRACKETS, " ").replace(BRACKET_LEADING_JUNK, "$1").replace(LONG_HEX, " ");
  t = t.replace(TERM, (_, article: string | undefined, term: string) => {
    const phrase = ACTION_PHRASE[term] ?? codeName(term, reasonNames);
    return article ? `${articleFor(article, phrase)} ${phrase}` : phrase;
  });
  t = t.replace(/\b[Aa]n?\s+(?=≈)/g, ""); // "a ≈ 15%" is "about 15 percent", not "a about 15 percent"
  for (const [pattern, words] of SYMBOLS) t = t.replace(pattern, words);
  t = t.replace(ISO_DATE, (iso, y: string, m: string, d: string) => {
    const month = MONTHS[Number(m) - 1];
    return month ? `${Number(d)} ${month} ${y}` : iso;
  });
  t = t.replace(CODE_THEN_AMOUNT, (_, code: string, amount: string) => `${amount} ${CURRENCY_NAME[code]}`);
  t = t.replace(MONEY, (_, sign: string, amount: string) => `${amount} ${CURRENCY_SIGN[sign]}`);
  t = t.replace(CURRENCY_CODE, (c) => CURRENCY_NAME[c]);
  t = t.replace(PERCENT, "$1 percent");
  t = t.replace(FIELD_TOKEN, (_, field: string, value?: string) => `${splitCamel(field)}${value ? ` is ${value}` : ""}`);
  // "blanket-PO exceedance" and "PO-2024-1150": the PO is the words, the digits are the number
  t = t.replace(/-PO\b/g, " purchase order").replace(/\bPO-(?=\d)/g, "purchase order ");
  for (const [pattern, words] of ABBREVIATIONS) t = t.replace(pattern, words);
  return t
    .replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, " ") // any snake_case left over
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])(?:\s*[.,;])+/g, "$1")
    .replace(/[,;]\s*([)\]])/g, "$1") // "(it lacks a link, <id>)" leaves "(it lacks a link,)"
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/^[\s.,;:]+/, "")
    .trim();
}

/** The part of `text` worth reading in full: up to maxChars, ending at a sentence, with a pointer to the screen if cut. */
export function spokenExcerpt(text: string, maxChars = 700): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const head = end > maxChars * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "");
  return `${head} The full answer is on the screen.`;
}

export const UNGROUNDED_SPOKEN_WARNING = "Caution: this answer did not cite a recorded decision.";

/**
 * What is read aloud for an explained answer: the answer in speakable form, trimmed to a sentence boundary, and, when the answer
 * did not cite a recorded decision, the same caution the screen shows. Listening alone must not make an unsupported answer
 * sound authoritative.
 */
export function buildSpokenAnswer({ answer, grounded }: { answer: string; grounded: boolean }, options: SpeakableOptions = {}): string {
  const body = speakableText(answer || "", options);
  if (!body) return "No explanation was returned.";
  const excerpt = spokenExcerpt(body);
  return grounded ? excerpt : `${excerpt} ${UNGROUNDED_SPOKEN_WARNING}`;
}

/** Chunks for the synthesiser: Chrome stalls on long utterances, so each is a sentence or two, and a number is never split. */
export function splitForSpeech(text: string, maxLen = 160): string[] {
  // a sentence ends at . ! ? followed by whitespace, so "1,200.50" and "3.5%" stay in one piece
  const pieces = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && `${current} ${piece}`.length <= maxLen) {
      current = `${current} ${piece}`;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    let rest = piece;
    // a single sentence longer than the limit is broken at a word boundary
    while (rest.length > maxLen) {
      let at = rest.lastIndexOf(" ", maxLen);
      if (at < maxLen * 0.4) at = maxLen;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface VoiceLike {
  lang: string;
  name?: string;
}

/** English voices first, Indian English best, then British, American, any English, any voice; null when there are none. */
export function pickVoice<V extends VoiceLike>(voices: V[] | null | undefined, preferredLang = "en-IN"): V | null {
  if (!voices || voices.length === 0) return null;
  const lang = (v: V) => (v.lang || "").replace("_", "-").toLowerCase();
  for (const wanted of [preferredLang.toLowerCase(), "en-gb", "en-us"]) {
    const hit = voices.find((v) => lang(v) === wanted);
    if (hit) return hit;
  }
  return voices.find((v) => lang(v).startsWith("en")) ?? voices[0];
}

// The newer neural kind of voice says so in its name: Microsoft Edge's "Microsoft Neerja Online (Natural) - English (India)",
// Windows "Natural" voices, macOS "Premium" and "Enhanced" voices. Chrome's own "Google ..." voices and the old built-in Windows
// ones do not, and are deliberately not counted: the button promises a natural voice, so it only says yes when the name does.
const NATURAL_NAME = /natural|neural|premium|enhanced/i;

export function isNaturalVoice(voice: VoiceLike): boolean {
  return NATURAL_NAME.test(voice.name ?? "");
}

/** The best natural English voice (Indian English first, then British, American, any English); null when there is none. */
export function pickNaturalVoice<V extends VoiceLike>(voices: V[] | null | undefined, preferredLang = "en-IN"): V | null {
  const english = (voices ?? []).filter((v) => isNaturalVoice(v) && /^en/i.test((v.lang || "").replace("_", "-")));
  return english.length > 0 ? pickVoice(english, preferredLang) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors, in words a person can act on
// ---------------------------------------------------------------------------------------------------------------------
const BLOCKED = "The microphone is blocked. Allow it for this site in the browser address bar, then try again.";
const ERROR_WORDS: Record<string, string> = {
  unsupported: "This browser can't listen. Type the question instead, or open this page in Chrome or Edge.",
  "not-allowed": BLOCKED,
  "service-not-allowed": BLOCKED,
  "audio-capture": "No microphone was found. Plug one in, or type the question.",
  "no-speech": "I didn't hear anything. Press the microphone and speak after it says Listening.",
  network: "The browser's speech service could not be reached. Check the connection, or type the question.",
  "language-not-supported": "This browser can't recognise that language. Type the question instead.",
  "bad-grammar": "The speech service rejected the request. Type the question instead.",
  // speaking
  "speech-stalled": "The browser did not play the audio. The answer is on the screen.",
  "synthesis-unavailable": "This browser has no voice to read with. The answer is on the screen.",
  "synthesis-failed": "The browser could not read that aloud. The answer is on the screen.",
  "audio-busy": "The speakers are busy with another app. The answer is on the screen.",
  "audio-hardware": "No speaker was found. The answer is on the screen.",
};

/** A message for a speech error code; null for a stop we asked for ("aborted", "interrupted", "canceled"), which is not an error. */
export function describeSpeechError(code: string | undefined): string | null {
  if (code === "aborted" || code === "interrupted" || code === "canceled") return null;
  if (code && ERROR_WORDS[code]) return ERROR_WORDS[code];
  return "Speech failed. Type the question instead; the answer is always on the screen.";
}

// ---------------------------------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------------------------------
/** The slice of the browser's SpeechRecognition that we use. */
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface RecognitionEventLike {
  resultIndex?: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export type RecognitionCtor = new () => RecognitionLike;

export interface UtteranceLike {
  lang: string;
  voice: unknown;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
export type UtteranceCtor = new (text: string) => UtteranceLike;
export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  resume?(): void;
  getVoices?(): VoiceLike[];
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ListenHandlers {
  /** The words heard so far, as they arrive. */
  onInterim?: (text: string) => void;
  /** Called once with the finished question. */
  onFinal?: (text: string) => void;
  /** Called once if it failed. */
  onError?: (error: { code: string; message: string }) => void;
  /** Always called exactly once, however listening ended (unless the controller was destroyed). */
  onEnd?: () => void;
}
export interface SpeakHandlers {
  /** The chosen voice never started, so the standard voice is saying it instead (called once, before the speech resumes). */
  onVoiceFallback?: () => void;
  onError?: (error: { code: string; message: string }) => void;
  /** Called once when speaking finished, was stopped, or failed (unless the controller was destroyed). */
  onEnd?: () => void;
}

export interface SpeechController {
  supportsListening: boolean;
  supportsSpeaking: boolean;
  listen(handlers?: ListenHandlers): boolean;
  stopListening(): void;
  speak(text: string, handlers?: SpeakHandlers): boolean;
  stopSpeaking(): void;
  /** Use this voice for what is spoken next; null goes back to the standard choice. */
  setVoice(voice: VoiceLike | null): void;
  getVoice(): VoiceLike | null;
  /** The browser's voices. Chrome and Edge fill the list a moment after load, so this waits for it (up to timeoutMs). */
  loadVoices(timeoutMs?: number): Promise<VoiceLike[]>;
  isListening(): boolean;
  isSpeaking(): boolean;
  destroy(): void;
}

export const NO_SPEECH_TIMEOUT_MS = 12_000;
export const MAX_LISTEN_MS = 30_000;
export const SPEAK_START_TIMEOUT_MS = 5_000;
export const VOICES_WAIT_MS = 2_000;
const SPEAK_MS_PER_CHAR = 140; // slow-voice upper bound; a chunk that takes longer than this has stalled

export interface ControllerOptions {
  recognitionCtor?: RecognitionCtor | null;
  synth?: SynthLike | null;
  utteranceCtor?: UtteranceCtor | null;
  lang?: string;
  timers?: Timers;
}

/**
 * One listener and one speaker, with every way they get stuck handled:
 * - a second listen() while listening is ignored; starting to listen silences the speaker, so the microphone never hears the answer;
 * - a recognition that ends with no words and no error is reported as "no-speech"; one that never ends is stopped by a timer;
 * - the transcript is rebuilt from the full result list each time, so a repeated event cannot double a word;
 * - speech is read a sentence or two at a time; each piece has a watchdog, because Chrome sometimes never fires `end`;
 * - stopSpeaking() resets the caller even if the browser fires no event; our own cancel is never reported as an error;
 * - the utterance being spoken is held in a variable, because Chrome can garbage-collect it mid-speech and never fire `end`.
 *
 * Browser objects are injected. A missing one means that half is unsupported (`supportsListening` / `supportsSpeaking`).
 */
export function createSpeechController({
  recognitionCtor = null,
  synth = null,
  utteranceCtor = null,
  lang = "en-IN",
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
}: ControllerOptions = {}): SpeechController {
  const supportsListening = typeof recognitionCtor === "function";
  const supportsSpeaking = Boolean(synth) && typeof utteranceCtor === "function";

  let recognition: RecognitionLike | null = null;
  let silenceTimer: unknown = null;
  let maxTimer: unknown = null;
  let destroyed = false;
  let active: { token: number; end: () => void } | null = null;
  let speakToken = 0;
  const inFlight = new Set<UtteranceLike>(); // holds the utterance being spoken; see the note above
  let preferredVoice: VoiceLike | null = null; // chosen by the person ("Naturalise tone"); null means the standard pick

  function readVoices(): VoiceLike[] {
    try {
      return synth?.getVoices?.() ?? [];
    } catch {
      return []; // voices are optional: a missing list just means the default voice
    }
  }
  readVoices(); // Chrome loads its voice list lazily; asking early means it is ready by the first answer

  function loadVoices(timeoutMs = VOICES_WAIT_MS): Promise<VoiceLike[]> {
    const now = readVoices();
    if (now.length > 0 || !synth?.addEventListener) return Promise.resolve(now);
    const source = synth;
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        source.removeEventListener?.("voiceschanged", onChange);
        if (timer) timers.clearTimeout(timer);
        resolve(readVoices());
      };
      const onChange = () => {
        if (readVoices().length > 0) finish();
      };
      source.addEventListener?.("voiceschanged", onChange);
      timer = timers.setTimeout(finish, timeoutMs); // some browsers never fire the event; an empty list is then the answer
    });
  }

  function setVoice(voice: VoiceLike | null) {
    preferredVoice = voice;
  }

  function clearListenTimers() {
    if (silenceTimer) timers.clearTimeout(silenceTimer);
    if (maxTimer) timers.clearTimeout(maxTimer);
    silenceTimer = maxTimer = null;
  }

  function stopListening() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* already stopped; onend will still fire or already has */
    }
  }

  function stopSpeaking() {
    speakToken += 1; // a piece still queued belongs to an older request and must not start
    const current = active;
    active = null;
    inFlight.clear();
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* a synthesiser that cannot cancel has nothing playing that we could stop */
      }
    }
    current?.end(); // the caller is reset even if the browser fires no event for the cancel
  }

  function listen({ onInterim, onFinal, onError, onEnd }: ListenHandlers = {}): boolean {
    if (destroyed) return false;
    if (!supportsListening || !recognitionCtor) {
      onError?.({ code: "unsupported", message: describeSpeechError("unsupported") as string });
      onEnd?.();
      return false;
    }
    if (recognition) return false; // already listening: a second press is not a second recogniser
    stopSpeaking();

    let transcript = "";
    let failed = false;
    let ended = false;
    const rec = new recognitionCtor();
    recognition = rec;
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    const finish = () => {
      if (ended) return;
      ended = true;
      clearListenTimers();
      if (recognition === rec) recognition = null;
      if (destroyed) return;
      const text = transcript.trim();
      if (!failed) {
        if (text) onFinal?.(text);
        else onError?.({ code: "no-speech", message: describeSpeechError("no-speech") as string });
      }
      onEnd?.();
    };

    rec.onresult = (event) => {
      if (destroyed) return;
      if (silenceTimer) {
        timers.clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) parts.push(event.results[i][0]?.transcript ?? "");
      transcript = parts.join(" ").replace(/\s+/g, " ").trim();
      if (transcript) onInterim?.(transcript);
    };
    rec.onerror = (event) => {
      const message = describeSpeechError(event.error);
      if (message === null) return; // "aborted": we stopped it on purpose
      failed = true;
      if (!destroyed) onError?.({ code: event.error ?? "unknown", message });
    };
    rec.onend = finish;

    try {
      rec.start();
    } catch {
      // start() throws if the page may not use the microphone, or a recogniser is already running (InvalidStateError)
      failed = true;
      onError?.({ code: "not-allowed", message: describeSpeechError("not-allowed") as string });
      finish();
      return false;
    }
    silenceTimer = timers.setTimeout(stopListening, NO_SPEECH_TIMEOUT_MS);
    maxTimer = timers.setTimeout(stopListening, MAX_LISTEN_MS);
    return true;
  }

  function speak(text: string, { onError, onEnd, onVoiceFallback }: SpeakHandlers = {}): boolean {
    if (destroyed || !supportsSpeaking || !synth || !utteranceCtor || !text || !text.trim()) {
      if (!destroyed) {
        if (text && text.trim() && !supportsSpeaking) onError?.({ code: "synthesis-unavailable", message: describeSpeechError("synthesis-unavailable") as string });
        onEnd?.();
      }
      return false;
    }
    stopSpeaking();
    const chunks = splitForSpeech(text);
    if (chunks.length === 0) {
      onEnd?.();
      return false;
    }
    const chosen = preferredVoice;
    let voice: VoiceLike | null = chosen ?? pickVoice(readVoices(), lang);
    let token = speakToken;
    let index = 0;
    let done = false;
    let startedAny = false;
    let fellBack = false;
    let watchdog: unknown = null;

    const clearWatchdog = () => {
      if (watchdog) timers.clearTimeout(watchdog);
      watchdog = null;
    };
    const end = () => {
      if (done) return;
      done = true;
      clearWatchdog();
      if (active?.token === token) active = null;
      if (!destroyed) onEnd?.();
    };
    const fail = (code: string) => {
      if (done) return;
      // A chosen voice that never made a sound (an online voice with the network down, a voice that was uninstalled): say the
      // same thing once with the standard voice instead of going silent. Only before anything was heard, so nothing is said twice.
      const standard = chosen && !fellBack && !startedAny && voice === chosen ? pickVoice(readVoices(), lang) : null;
      if (chosen && standard && !(standard.name === chosen.name && standard.lang === chosen.lang)) {
        fellBack = true;
        if (preferredVoice === chosen) preferredVoice = null;
        voice = standard;
        clearWatchdog();
        speakToken += 1;
        token = speakToken;
        active = { token, end };
        inFlight.clear();
        index = 0;
        try {
          synth.cancel();
        } catch {
          /* nothing playing */
        }
        if (!destroyed) onVoiceFallback?.();
        next();
        return;
      }
      if (!destroyed) onError?.({ code, message: describeSpeechError(code) as string });
      speakToken += 1;
      inFlight.clear();
      try {
        synth.cancel();
      } catch {
        /* nothing playing */
      }
      end();
    };
    const next = () => {
      clearWatchdog();
      if (done || token !== speakToken || destroyed) return;
      if (index >= chunks.length) {
        inFlight.clear();
        return end();
      }
      const chunk = chunks[index];
      index += 1;
      const mine = token; // an event from an attempt that was since abandoned (a stop, or the fallback voice) must be ignored
      const utterance = new utteranceCtor(chunk);
      inFlight.clear();
      inFlight.add(utterance);
      utterance.lang = voice?.lang || lang;
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (mine !== speakToken) return;
        startedAny = true;
        clearWatchdog();
        watchdog = timers.setTimeout(() => fail("speech-stalled"), 4_000 + chunk.length * SPEAK_MS_PER_CHAR);
      };
      utterance.onend = () => {
        if (mine === speakToken) next();
      };
      utterance.onerror = (event) => {
        if (mine !== speakToken) return; // ours: stopSpeaking() already reset the caller
        const message = describeSpeechError(event.error);
        if (message === null) return end();
        fail(event.error ?? "synthesis-failed");
      };
      watchdog = timers.setTimeout(() => fail("speech-stalled"), SPEAK_START_TIMEOUT_MS);
      try {
        synth.speak(utterance);
      } catch {
        fail("synthesis-failed");
      }
    };

    active = { token, end };
    try {
      synth.resume?.(); // Chrome can be left paused by an earlier page
    } catch {
      /* nothing to resume */
    }
    next();
    return true;
  }

  function destroy() {
    destroyed = true;
    clearListenTimers();
    if (recognition) {
      const rec = recognition;
      recognition = null;
      rec.onresult = rec.onerror = rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already gone */
      }
    }
    stopSpeaking();
  }

  return {
    supportsListening,
    supportsSpeaking,
    listen,
    stopListening,
    speak,
    stopSpeaking,
    setVoice,
    getVoice: () => preferredVoice,
    loadVoices,
    isListening: () => recognition !== null,
    isSpeaking: () => active !== null,
    destroy,
  };
}
