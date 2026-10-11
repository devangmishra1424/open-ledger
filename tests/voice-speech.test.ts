import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LISTEN_MS,
  NO_SPEECH_TIMEOUT_MS,
  SPEAK_START_TIMEOUT_MS,
  VOICES_WAIT_MS,
  UNGROUNDED_SPOKEN_WARNING,
  buildSpokenAnswer,
  createSpeechController,
  describeSpeechError,
  isNaturalVoice,
  pickNaturalVoice,
  pickVoice,
  speakableText,
  splitForSpeech,
  spokenExcerpt,
  type RecognitionEventLike,
  type RecognitionLike,
  type SynthLike,
  type UtteranceLike,
  type VoiceLike,
} from "../frontend/src/lib/speech";

/**
 * Voice Q&A. The browser's SpeechRecognition / speechSynthesis are replaced with fakes that can be driven event by event, so
 * the failure paths (denied microphone, silence, double press, a recogniser or voice that goes quiet) are tested, not just the
 * happy path. What this cannot show is how a real microphone and a real voice behave; that part is a manual check.
 */

const ID = "3f2a9c1e-5b7d-4e8a-9c3b-1d2e3f4a5b6c";
const ID2 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("speakableText", () => {
  it("removes record ids, in brackets or bare, and leaves a clean sentence", () => {
    expect(speakableText(`It was held because the price was high (see decision ${ID}).`)).toBe("It was held because the price was high.");
    expect(speakableText(`Held [decision ids: ${ID}, ${ID2}] for review.`)).toBe("Held for review.");
    expect(speakableText(`Per decision ${ID} the total is over the limit.`)).toBe("the total is over the limit.");
    expect(speakableText(`Stray ${ID} id.`)).not.toContain(ID);
  });

  it("removes ids the model wrapped in markdown bold (seen in a real answer)", () => {
    const live = "The prices did **not** match; the total of $17,710 exceeds the PO amount of $15,400, triggering an EXC-PRICE_VAR exception (see decision **9f8993d7-0e57-481f-a7ab-ee829daae41a**).";
    expect(speakableText(live, { reasonNames: { "EXC-PRICE_VAR": "a price difference" } })).toBe(
      "The prices did not match; the total of 17,710 dollars exceeds the purchase order amount of 15,400 dollars, triggering an a price difference exception.",
    );
    expect(speakableText("Held (see decision `" + ID + "`).")).toBe("Held.");
  });

  it("removes ids the model wrapped in angle brackets (seen in a real answer)", () => {
    const live = `The problem was first flagged at the **match** step (decision <${ID}>), which blocked the invoice with reason EXC-PRICE_VAR, and reinforced at the **audit** step (decision <${ID2}>).`;
    expect(speakableText(live, { reasonNames: { "EXC-PRICE_VAR": "a price difference" } })).toBe(
      "The problem was first flagged at the match step, which blocked the invoice with reason a price difference, and reinforced at the audit step.",
    );
  });

  it("reads the awkward constructions seen in real answers", () => {
    const EN = String.fromCharCode(0x2013);
    // several ids, each with its own "see decision", in one bracket: nothing of it is left behind
    expect(speakableText(`flagged (see decision ${ID}; see decision ${ID2}) twice`)).toBe("flagged twice");
    // an id followed by a clause worth keeping
    expect(speakableText(`The same (see decision ${ID} ${EN} reason EXC-NON_PO) applies.`)).toBe("The same (reason non purchase order) applies.");
    // currency code before the amount, symbols, dashes
    expect(speakableText("its total of USD 12,500 exceeds the ceiling of USD 10,000")).toBe("its total of 12,500 US dollars exceeds the ceiling of 10,000 US dollars");
    expect(speakableText("a ≈ 15 % over-charge")).toBe("about 15 percent over-charge");
    expect(speakableText(`held ${EN} the vendor is new`)).toBe("held, the vendor is new");
    expect(speakableText(`between 10${EN}20 days`)).toBe("between 10 to 20 days");
    expect(speakableText(`down by ${String.fromCharCode(0x2212)}500`)).toBe("down by minus 500");
    expect(speakableText("Total owed → paid")).toBe("Total owed to paid");
    expect(speakableText("terms & conditions")).toBe("terms and conditions");
  });

  it("removes a list of three ids ending in ', and', and reads PO references and 'blanket-PO' sensibly (seen in real answers)", () => {
    expect(speakableText(`received approvals in the match, audit, and policy nodes (see decisions ${ID}, ${ID2}, and ${ID})`)).toBe("received approvals in the match, audit, and policy nodes");
    expect(speakableText(`first (see decision ${ID} and decision ${ID2}) then more`)).toBe("first then more");
    expect(speakableText("the block is due to the blanket-PO exceedance")).toBe("the block is due to the blanket purchase order exceedance");
    expect(speakableText("did not align with PO PO-2024-1150.")).toBe("did not align with purchase order purchase order 2024-1150.");
    expect(speakableText("over ( about 15 percent )")).toBe("over (about 15 percent)");
    expect(speakableText(`(the invoice lacks a linkage, see decision ${ID})`)).toBe("(the invoice lacks a linkage)");
  });

  it("drops long hashes but keeps long numbers such as account numbers", () => {
    expect(speakableText("Chain head 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 is intact.")).toBe("Chain head is intact.");
    expect(speakableText("Account 1234567890123456 was charged.")).toContain("1234567890123456");
  });

  it("puts exception codes into the screen's plain names, and actions into short noun phrases that fit the sentence", () => {
    const out = speakableText("EXC-PRICE_VARIANCE maps to escalate_l2, not auto_approve.", {
      reasonNames: { "EXC-PRICE_VARIANCE": "Price differs from the purchase order" },
    });
    expect(out).toBe("Price differs from the purchase order maps to level 2 escalation, not automatic approval.");
  });

  it("fixes a/an in front of a code that was replaced by words", () => {
    const names = { "EXC-PRICE_VAR": "Price Variance", "EXC-LAYOUT": "Unreadable Invoice Layout", "EXC-UOM_MISMATCH": "Unit-of-Measure Mismatch", "EXC-BEFORE_RCV": "Invoice Before Receipt" };
    expect(speakableText("triggers an EXC-PRICE_VAR exception", { reasonNames: names })).toBe("triggers a Price Variance exception");
    expect(speakableText("It is a EXC-LAYOUT case", { reasonNames: names })).toBe("It is an Unreadable Invoice Layout case");
    expect(speakableText("a EXC-UOM_MISMATCH was found", { reasonNames: names })).toBe("a Unit-of-Measure Mismatch was found");
    expect(speakableText("An EXC-BEFORE_RCV exception", { reasonNames: names })).toBe("An Invoice Before Receipt exception");
    expect(speakableText("maps to an escalate_l2 action")).toBe("maps to a level 2 escalation action");
  });

  it("finds a code the model spelled with a hyphen where the code has an underscore (EXC-FRAUD-BANK for EXC-FRAUD_BANK)", () => {
    const names = { "EXC-FRAUD_BANK": "Vendor Bank Detail Change" };
    expect(speakableText("blocked it for “EXC-FRAUD-BANK”", { reasonNames: names })).toContain("Vendor Bank Detail Change");
    expect(speakableText("EXC-FRAUD-BANK")).toBe("fraud bank");
  });

  it("recognises codes the model wrote with a non-breaking hyphen (seen in a real answer) and no-break spaces in numbers", () => {
    // exact characters from a live answer: U+2011 inside the code and in "price\u2011variance"
    const live = "the audit node flagged EXC\u2011PRICE_VAR and the match node also blocked for EXC\u2011PRICE_VAR.";
    expect(speakableText(live, { reasonNames: { "EXC-PRICE_VAR": "Price differs from the order" } })).toBe(
      "the audit node flagged Price differs from the order and the match node also blocked for Price differs from the order.",
    );
    expect(speakableText("a price\u2011variance exception")).toBe("a price-variance exception");
    // a figure grouped with a no-break space is one number, never "17 dollars ... 710"
    expect(speakableText("Total $17\u202f710 due")).toBe("Total 17,710 dollars due");
    expect(speakableText("Total 1\u00a0234\u00a0567.50 USD")).toBe("Total 1,234,567.50 US dollars");
    expect(speakableText("Rows 12\u00a0345 of 3\u00a0000")).toBe("Rows 12,345 of 3,000");
    expect(speakableText("Items 5\u00a012")).toBe("Items 5 12"); // not a three-digit group: left alone
  });

  it("falls back to a readable form when no name is known", () => {
    expect(speakableText("EXC-CREDIT_MEMO then escalate_l1")).toBe("credit memo then level 1 escalation");
    expect(speakableText("EXC-NON_PO and EXC-PRICE_VAR and EXC-QTY_VAR")).toBe("non purchase order and price variance and quantity variance");
  });

  it("drops markdown marks but keeps underscores that are part of a word", () => {
    expect(speakableText("**Held** for `review`. The payment_failed event")).toBe("Held for review. The payment failed event");
    expect(speakableText("> quoted line\n- first point\n- second point")).toBe("quoted line. first point. second point"); // a bullet becomes a pause
  });

  it("says money, currency codes, percentages and dates in words", () => {
    expect(speakableText("Over-charge of $2,310 on $17,710")).toBe("Over-charge of 2,310 dollars on 17,710 dollars");
    expect(speakableText("Total 1,234.56 USD, then €40 and ₹500")).toBe("Total 1,234.56 US dollars, then 40 euros and 500 rupees");
    expect(speakableText("a +15.0% variance")).toBe("a +15.0 percent variance");
    expect(speakableText("Receipt dated 2026-10-08.")).toBe("Receipt dated 8 October 2026.");
    expect(speakableText("Date 2026-13-40 is odd")).toContain("2026-13-40");
  });

  it("turns field names into words and = into 'is'", () => {
    expect(speakableText("the line unitPrice=$17,710 and tolerancePct=0.02")).toBe("the line unit price is 17,710 dollars and tolerance percent is 0.02");
    expect(speakableText("matchedCount is 1")).toBe("matched count is 1");
    expect(speakableText("(upTo50000=escalate_l2)")).toBe("(up to 50000 is level 2 escalation)");
  });

  it("expands accounts-payable abbreviations", () => {
    expect(speakableText("The PO and GRN agree; POs are open.")).toBe("The purchase order and goods receipt agree; purchase orders are open.");
  });

  it("never drops a figure from a realistic recorded answer", () => {
    const answer = `Verifier disagreed with the Investigator: the line "matchedCount" is 1 and unitPrice=$17,710 (USD, exchangeRate 1). That's a $2,310 over-charge, +15.0% variance, above the 2% (tolerancePct=0.02) allowed. At $17,710, EXC-PRICE_VAR maps to escalate_l2 (upTo50000=escalate_l2) (see decision ${ID}). Receipt dated 2026-10-08.`;
    const spoken = speakableText(answer);
    for (const figure of ["17,710", "2,310", "15.0", "0.02", "50000", "2026", "October"]) expect(spoken).toContain(figure);
    expect(spoken).not.toContain(ID);
    expect(spoken).not.toMatch(/[A-Z]{3,}-[A-Z_]+|_l[12]|[a-z][A-Z]/); // no codes, snake_case actions or camelCase left
    expect(spoken).not.toMatch(/\s[.,;]/);
  });

  it("returns an empty string for non-text instead of throwing", () => {
    expect(speakableText(undefined as unknown as string)).toBe("");
    expect(speakableText("")).toBe("");
    expect(speakableText(`(see decision ${ID})`)).toBe("");
  });
});

describe("spokenExcerpt", () => {
  it("passes short text through and cuts long text at a sentence with a pointer to the screen", () => {
    expect(spokenExcerpt("Short answer.")).toBe("Short answer.");
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = spokenExcerpt(long, 200);
    expect(out.endsWith("The full answer is on the screen.")).toBe(true);
    expect(out).toContain("Sentence number 0 is here.");
    expect(out.length).toBeLessThan(260);
    expect(out).toMatch(/here\. The full answer/); // cut at a sentence end, not mid-word
  });
});

describe("buildSpokenAnswer", () => {
  it("reads a grounded answer as is, without ids", () => {
    const out = buildSpokenAnswer({ answer: `Held because the total is $60,000 (see decision ${ID}).`, grounded: true });
    expect(out).toBe("Held because the total is 60,000 dollars.");
  });

  it("adds the same caution the screen shows when the answer cited no recorded decision", () => {
    const out = buildSpokenAnswer({ answer: "It was probably the price.", grounded: false });
    expect(out).toBe(`It was probably the price. ${UNGROUNDED_SPOKEN_WARNING}`);
  });

  it("says so when there is nothing to read, instead of staying silent", () => {
    expect(buildSpokenAnswer({ answer: "", grounded: true })).toBe("No explanation was returned.");
    expect(buildSpokenAnswer({ answer: `(see decision ${ID})`, grounded: false })).toBe("No explanation was returned.");
  });

  it("keeps the caution even when a long answer is cut", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence ${i} says something.`).join(" ");
    const out = buildSpokenAnswer({ answer: long, grounded: false });
    expect(out).toContain("The full answer is on the screen.");
    expect(out.endsWith(UNGROUNDED_SPOKEN_WARNING)).toBe(true);
  });
});

describe("splitForSpeech", () => {
  it("keeps decimals together and is lossless", () => {
    const text = "The total was 1,234.56 dollars. The tolerance is 3.5 percent! Is that right? Yes.";
    const chunks = splitForSpeech(text, 40);
    expect(chunks.join(" ")).toBe(text);
    expect(chunks.some((c) => c.includes("1,234.56"))).toBe(true);
    expect(chunks.some((c) => c.includes("3.5"))).toBe(true);
  });

  it("keeps every chunk within the limit, breaking a very long sentence at word boundaries", () => {
    const text = `${"word ".repeat(120).trim()}.`;
    const chunks = splitForSpeech(text, 100);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(" ")).toBe(text);
  });

  it("returns nothing for empty text and one chunk for a short one", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("   ")).toEqual([]);
    expect(splitForSpeech("Hello there.")).toEqual(["Hello there."]);
  });
});

describe("pickVoice", () => {
  const v = (lang: string, name = lang): VoiceLike => ({ lang, name });
  it("prefers Indian English, then British, American, any English, then anything", () => {
    expect(pickVoice([v("en-US"), v("en-IN"), v("en-GB")])?.lang).toBe("en-IN");
    expect(pickVoice([v("fr-FR"), v("en-US"), v("en-GB")])?.lang).toBe("en-GB");
    expect(pickVoice([v("fr-FR"), v("en-US")])?.lang).toBe("en-US");
    expect(pickVoice([v("fr-FR"), v("en-AU")])?.lang).toBe("en-AU");
    expect(pickVoice([v("fr-FR"), v("de-DE")])?.lang).toBe("fr-FR");
  });
  it("understands underscore language tags (some Android voices) and returns null for none", () => {
    expect(pickVoice([v("en_IN")])?.lang).toBe("en_IN");
    expect(pickVoice([])).toBeNull();
    expect(pickVoice(null)).toBeNull();
  });
});

describe("describeSpeechError", () => {
  it("gives an actionable message per code, and null for stops we asked for", () => {
    expect(describeSpeechError("not-allowed")).toMatch(/blocked/i);
    expect(describeSpeechError("audio-capture")).toMatch(/microphone/i);
    expect(describeSpeechError("network")).toMatch(/connection/i);
    expect(describeSpeechError("aborted")).toBeNull();
    expect(describeSpeechError("interrupted")).toBeNull();
    expect(describeSpeechError("canceled")).toBeNull();
  });
  it("never returns an empty message for an unknown code", () => {
    expect(describeSpeechError("something-new")).toMatch(/type the question/i);
    expect(describeSpeechError(undefined)).toMatch(/type the question/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------------------------------
class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  static startThrows = false;
  lang = "";
  interimResults = false;
  continuous = true;
  maxAlternatives = 0;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  started = false;
  stopped = 0;
  aborted = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.startThrows) throw new DOMException("not allowed", "NotAllowedError");
    this.started = true;
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  // helpers that drive it the way a browser would
  say(results: Array<[string, boolean]>) {
    const event: RecognitionEventLike = { results: results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) as never };
    this.onresult?.(event);
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  end() {
    this.onend?.();
  }
}

class FakeUtterance implements UtteranceLike {
  lang = "";
  voice: unknown = null;
  onstart: UtteranceLike["onstart"] = null;
  onend: UtteranceLike["onend"] = null;
  onerror: UtteranceLike["onerror"] = null;
  constructor(public text: string) {}
}

class FakeSynth implements SynthLike {
  spoken: FakeUtterance[] = [];
  cancels = 0;
  voices: VoiceLike[] = [];
  speakThrows = false;
  listeners = new Set<() => void>();
  addEventListener(type: string, fn: () => void) {
    if (type === "voiceschanged") this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: () => void) {
    this.listeners.delete(fn);
  }
  /** The browser finishing its voice list, a moment after the page loaded. */
  loadLater(voices: VoiceLike[]) {
    this.voices = voices;
    this.listeners.forEach((fn) => fn());
  }
  speak(u: UtteranceLike) {
    if (this.speakThrows) throw new Error("synth broken");
    this.spoken.push(u as FakeUtterance);
  }
  cancel() {
    this.cancels += 1;
  }
  getVoices() {
    return this.voices;
  }
  get last() {
    return this.spoken[this.spoken.length - 1];
  }
}

function recorder() {
  const log: string[] = [];
  return {
    log,
    handlers: {
      onInterim: (t: string) => log.push(`interim:${t}`),
      onFinal: (t: string) => log.push(`final:${t}`),
      onError: (e: { code: string }) => log.push(`error:${e.code}`),
      onEnd: () => log.push("end"),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  FakeRecognition.startThrows = false;
});
afterEach(() => {
  vi.useRealTimers();
});

function listener(opts: { synth?: FakeSynth } = {}) {
  return createSpeechController({ recognitionCtor: FakeRecognition, synth: opts.synth ?? null, utteranceCtor: opts.synth ? FakeUtterance : null });
}

describe("listening", () => {
  it("reports words as they arrive, then one final question and one end", () => {
    const { log, handlers } = recorder();
    const c = listener();
    expect(c.listen(handlers)).toBe(true);
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe("en-IN");
    expect(rec.interimResults).toBe(true);
    expect(rec.continuous).toBe(false);
    rec.say([["why was", false]]);
    rec.say([["why was this invoice held", true]]);
    rec.end();
    expect(log).toEqual(["interim:why was", "interim:why was this invoice held", "final:why was this invoice held", "end"]);
    expect(c.isListening()).toBe(false);
  });

  it("joins several results and does not double a word when the same event is replayed", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    const rec = FakeRecognition.instances[0];
    rec.say([["why was it", true], ["held", false]]);
    rec.say([["why was it", true], ["held", true]]);
    rec.say([["why was it", true], ["held", true]]); // replayed (a known Android quirk)
    rec.end();
    expect(log.filter((l) => l.startsWith("final:"))).toEqual(["final:why was it held"]);
  });

  it("submits the last words heard if recognition ends before marking them final", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    const rec = FakeRecognition.instances[0];
    rec.say([["what is the total", false]]);
    rec.end();
    expect(log.filter((l) => l.startsWith("final:"))).toEqual(["final:what is the total"]);
  });

  it("says 'no-speech' exactly once when nothing was heard, with no final question", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    FakeRecognition.instances[0].end();
    expect(log).toEqual(["error:no-speech", "end"]);
  });

  it("reports a denied microphone once, not also as 'no-speech', and never as a question", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    const rec = FakeRecognition.instances[0];
    rec.fail("not-allowed");
    rec.end();
    expect(log).toEqual(["error:not-allowed", "end"]);
  });

  it("does not treat a stop we asked for ('aborted') as an error", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    const rec = FakeRecognition.instances[0];
    rec.say([["partial words", false]]);
    rec.fail("aborted");
    rec.end();
    expect(log.some((l) => l.startsWith("error:") && l !== "error:no-speech")).toBe(false);
  });

  it("ignores a second press while listening instead of starting a second recogniser", () => {
    const c = listener();
    expect(c.listen()).toBe(true);
    expect(c.listen()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("can listen again after a recording ended", () => {
    const c = listener();
    c.listen();
    FakeRecognition.instances[0].end();
    expect(c.listen()).toBe(true);
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("is unsupported without a recogniser: says so, still ends, and starts nothing", () => {
    const { log, handlers } = recorder();
    const c = createSpeechController({});
    expect(c.supportsListening).toBe(false);
    expect(c.listen(handlers)).toBe(false);
    expect(log).toEqual(["error:unsupported", "end"]);
  });

  it("recovers when start() throws: one error, one end, and the next press works", () => {
    const { log, handlers } = recorder();
    const c = listener();
    FakeRecognition.startThrows = true;
    expect(c.listen(handlers)).toBe(false);
    expect(log).toEqual(["error:not-allowed", "end"]);
    expect(c.isListening()).toBe(false);
    FakeRecognition.startThrows = false;
    expect(c.listen()).toBe(true);
  });

  it("stops by itself after 12 s of silence, and after 30 s even if words keep trickling in", () => {
    const c = listener();
    c.listen();
    const rec = FakeRecognition.instances[0];
    vi.advanceTimersByTime(NO_SPEECH_TIMEOUT_MS - 1);
    expect(rec.stopped).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rec.stopped).toBe(1);

    const c2 = listener();
    c2.listen();
    const rec2 = FakeRecognition.instances[1];
    rec2.say([["still talking", false]]); // words arrived: the silence timer no longer applies
    vi.advanceTimersByTime(NO_SPEECH_TIMEOUT_MS + 1000);
    expect(rec2.stopped).toBe(0);
    vi.advanceTimersByTime(MAX_LISTEN_MS);
    expect(rec2.stopped).toBe(1);
  });

  it("clears its timers when listening ends, so nothing fires later", () => {
    const c = listener();
    c.listen();
    const rec = FakeRecognition.instances[0];
    rec.say([["done", true]]);
    rec.end();
    vi.advanceTimersByTime(MAX_LISTEN_MS * 2);
    expect(rec.stopped).toBe(0);
  });

  it("silences the speaker when the microphone opens, so it cannot hear the answer", () => {
    const synth = new FakeSynth();
    const c = listener({ synth });
    c.speak("An answer that is being read aloud.");
    const before = synth.cancels;
    c.listen();
    expect(synth.cancels).toBeGreaterThan(before);
    expect(c.isSpeaking()).toBe(false);
  });

  it("stopListening asks the recogniser to stop (it then delivers what it has)", () => {
    const c = listener();
    c.listen();
    c.stopListening();
    expect(FakeRecognition.instances[0].stopped).toBe(1);
  });

  it("destroy aborts the recogniser and then delivers nothing", () => {
    const { log, handlers } = recorder();
    const c = listener();
    c.listen(handlers);
    const rec = FakeRecognition.instances[0];
    c.destroy();
    expect(rec.aborted).toBe(1);
    expect(rec.onresult).toBeNull();
    expect(c.listen(handlers)).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("speaking", () => {
  const sentence = (n: number) => `This is sentence number ${n} and it has enough words to need its own piece.`;
  const long = [1, 2, 3, 4].map(sentence).join(" ");

  it("reads one piece at a time, in order, and reports the end once", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    expect(c.speak(long, { onEnd })).toBe(true);
    expect(c.isSpeaking()).toBe(true);
    expect(synth.spoken).toHaveLength(1); // the next piece waits for the first to finish
    const pieces = splitForSpeech(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (let i = 0; i < pieces.length; i += 1) {
      expect(synth.spoken).toHaveLength(i + 1);
      expect(synth.last.text).toBe(pieces[i]);
      synth.last.onstart?.();
      synth.last.onend?.();
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(c.isSpeaking()).toBe(false);
    expect(synth.spoken.map((u) => u.text).join(" ")).toBe(long);
  });

  it("cancels whatever was playing before it starts, and picks an Indian-English voice when there is one", () => {
    const synth = new FakeSynth();
    synth.voices = [{ lang: "en-US", name: "US" }, { lang: "en-IN", name: "IN" }];
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    c.speak("Hello there.");
    expect(synth.cancels).toBeGreaterThanOrEqual(1);
    expect((synth.last.voice as VoiceLike).name).toBe("IN");
    expect(synth.last.lang).toBe("en-IN");
  });

  it("works with no voices loaded yet, using the language tag", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    c.speak("Hello there.");
    expect(synth.last.voice).toBeNull();
    expect(synth.last.lang).toBe("en-IN");
  });

  it("stop: resets the caller once, even if the browser fires no event, and the old piece cannot start the next", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    c.speak(long, { onEnd, onError });
    const first = synth.last;
    first.onstart?.();
    const cancelsBefore = synth.cancels;
    c.stopSpeaking();
    expect(synth.cancels).toBe(cancelsBefore + 1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    first.onerror?.({ error: "interrupted" }); // what Chrome does after cancel()
    first.onend?.(); // and sometimes this too
    expect(synth.spoken).toHaveLength(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(c.isSpeaking()).toBe(false);
  });

  it("a new answer replaces the old one: the old request ends once, the new one plays", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const endA = vi.fn();
    const endB = vi.fn();
    c.speak(long, { onEnd: endA });
    const a = synth.last;
    c.speak("A different answer.", { onEnd: endB });
    expect(endA).toHaveBeenCalledTimes(1);
    a.onend?.(); // the superseded piece finishing late must not advance anything
    expect(synth.last.text).toBe("A different answer.");
    expect(synth.spoken.filter((u) => u.text.startsWith("This is sentence"))).toHaveLength(1);
    synth.last.onstart?.();
    synth.last.onend?.();
    expect(endB).toHaveBeenCalledTimes(1);
    expect(endA).toHaveBeenCalledTimes(1);
  });

  it("reports a real synthesis error once, stops, and does not read on", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    c.speak(long, { onEnd, onError });
    synth.last.onerror?.({ error: "synthesis-failed" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("synthesis-failed");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(1);
    expect(c.isSpeaking()).toBe(false);
  });

  it("notices a voice that never starts (watchdog), says so once, and recovers", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    c.speak("Hello there.", { onEnd, onError });
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS - 1);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("speech-stalled");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(c.isSpeaking()).toBe(false);
    expect(synth.cancels).toBeGreaterThanOrEqual(2);
    expect(c.speak("Try again.")).toBe(true); // usable afterwards
  });

  it("notices a voice that starts and then goes quiet", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onError = vi.fn();
    c.speak("Hello there.", { onError });
    synth.last.onstart?.();
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS + 1); // the start deadline no longer applies once it has started
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_000 + "Hello there.".length * 140);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind once speech finishes normally", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onError = vi.fn();
    c.speak("Hello there.", { onError });
    synth.last.onstart?.();
    synth.last.onend?.();
    vi.advanceTimersByTime(120_000);
    expect(onError).not.toHaveBeenCalled();
  });

  it("recovers if speak() itself throws", () => {
    const synth = new FakeSynth();
    synth.speakThrows = true;
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    c.speak("Hello there.", { onEnd, onError });
    expect(onError.mock.calls[0][0].code).toBe("synthesis-failed");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(c.isSpeaking()).toBe(false);
  });

  it("without a synthesiser: says it cannot, still ends, speaks nothing", () => {
    const c = createSpeechController({});
    expect(c.supportsSpeaking).toBe(false);
    const onEnd = vi.fn();
    const onError = vi.fn();
    expect(c.speak("Hello.", { onEnd, onError })).toBe(false);
    expect(onError.mock.calls[0][0].code).toBe("synthesis-unavailable");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("empty text: nothing to say, no error, still ends", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    expect(c.speak("   ", { onEnd, onError })).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(0);
  });

  it("destroy cancels speech and then delivers nothing, even if the browser fires late events", () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const onEnd = vi.fn();
    const onError = vi.fn();
    c.speak(long, { onEnd, onError });
    const first = synth.last;
    c.destroy();
    first.onerror?.({ error: "interrupted" });
    first.onend?.();
    vi.advanceTimersByTime(120_000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(synth.spoken).toHaveLength(1);
    expect(c.speak("late")).toBe(false);
  });
});

describe("natural voices", () => {
  const v = (name: string, lang: string): VoiceLike => ({ name, lang });

  it("counts a voice as natural only when its name says so", () => {
    for (const name of ["Microsoft Neerja Online (Natural) - English (India)", "Microsoft Aria Online (Natural) - English (United States)", "Samantha (Enhanced)", "Zoe (Premium)", "Some Neural Voice"]) {
      expect(isNaturalVoice(v(name, "en-US"))).toBe(true);
    }
    for (const name of ["Microsoft Heera - English (India)", "Microsoft David - English (United States)", "Google US English", "Google UK English Female"]) {
      expect(isNaturalVoice(v(name, "en-US"))).toBe(false);
    }
    expect(isNaturalVoice({ lang: "en-US" })).toBe(false);
  });

  it("picks the natural English voice, Indian English first, ignoring natural voices in other languages and standard ones", () => {
    const voices = [
      v("Microsoft Heera - English (India)", "en-IN"),
      v("Microsoft Swara Online (Natural) - Hindi (India)", "hi-IN"),
      v("Microsoft Aria Online (Natural) - English (United States)", "en-US"),
      v("Microsoft Neerja Online (Natural) - English (India)", "en-IN"),
      v("Microsoft Sonia Online (Natural) - English (United Kingdom)", "en-GB"),
    ];
    expect(pickNaturalVoice(voices)?.name).toBe("Microsoft Neerja Online (Natural) - English (India)");
    expect(pickNaturalVoice(voices.filter((x) => x.lang !== "en-IN" || !isNaturalVoice(x)))?.name).toBe("Microsoft Sonia Online (Natural) - English (United Kingdom)");
  });

  it("is null when there is no natural English voice, or no voices at all", () => {
    expect(pickNaturalVoice([v("Microsoft Heera - English (India)", "en-IN"), v("Microsoft Swara Online (Natural) - Hindi (India)", "hi-IN")])).toBeNull();
    expect(pickNaturalVoice([])).toBeNull();
    expect(pickNaturalVoice(null)).toBeNull();
    expect(pickNaturalVoice(undefined)).toBeNull();
  });
});

describe("loadVoices", () => {
  const voice: VoiceLike = { name: "Microsoft Neerja Online (Natural) - English (India)", lang: "en-IN" };

  it("returns the list straight away when the browser already has it", async () => {
    const synth = new FakeSynth();
    synth.voices = [voice];
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    await expect(c.loadVoices()).resolves.toEqual([voice]);
    expect(synth.listeners.size).toBe(0);
  });

  it("waits for the voice list that Chrome and Edge fill in after load, then stops listening for the event", async () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const pending = c.loadVoices();
    expect(synth.listeners.size).toBe(1);
    synth.loadLater([voice]);
    await expect(pending).resolves.toEqual([voice]);
    expect(synth.listeners.size).toBe(0);
  });

  it("gives up after the wait and returns an empty list when the event never comes", async () => {
    const synth = new FakeSynth();
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    const pending = c.loadVoices();
    vi.advanceTimersByTime(VOICES_WAIT_MS - 1);
    synth.loadLater([]); // fired, but still nothing in the list: keep waiting
    expect(synth.listeners.size).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual([]);
    expect(synth.listeners.size).toBe(0);
  });

  it("returns what there is when the browser has no voice events, and an empty list with no synthesiser", async () => {
    const synth = new FakeSynth();
    (synth as unknown as { addEventListener?: unknown }).addEventListener = undefined;
    await expect(createSpeechController({ synth, utteranceCtor: FakeUtterance }).loadVoices()).resolves.toEqual([]);
    await expect(createSpeechController({}).loadVoices()).resolves.toEqual([]);
  });
});

describe("a chosen (natural) voice", () => {
  const natural: VoiceLike = { name: "Microsoft Neerja Online (Natural) - English (India)", lang: "en-IN" };
  const standard: VoiceLike = { name: "Microsoft Heera - English (India)", lang: "en-IN" };
  const setup = () => {
    const synth = new FakeSynth();
    synth.voices = [standard, natural];
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    return { synth, c };
  };

  it("is used for what is spoken next, and the standard pick comes back with setVoice(null)", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    expect(c.getVoice()).toBe(natural);
    c.speak("Hello there.");
    expect(synth.last.voice).toBe(natural);
    c.setVoice(null);
    c.speak("Hello again.");
    expect(synth.last.voice).toBe(standard);
    expect(c.getVoice()).toBeNull();
  });

  it("falls back to the standard voice, once and audibly, when the chosen voice never starts", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onVoiceFallback = vi.fn();
    c.speak("Hello there.", { onEnd, onError, onVoiceFallback });
    const first = synth.last;
    expect(first.voice).toBe(natural);
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS);
    expect(onVoiceFallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled(); // still going: now with the standard voice
    expect(synth.spoken).toHaveLength(2);
    expect(synth.last.voice).toBe(standard);
    expect(synth.last.text).toBe("Hello there.");
    expect(c.getVoice()).toBeNull(); // so the next answer does not wait for the same broken voice
    expect(c.isSpeaking()).toBe(true);
    first.onstart?.(); // the abandoned attempt waking up late changes nothing
    first.onend?.();
    expect(synth.spoken).toHaveLength(2);
    synth.last.onstart?.();
    synth.last.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(c.isSpeaking()).toBe(false);
  });

  it("falls back when the chosen voice reports an error before it started, and reads every piece with the standard voice", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onVoiceFallback = vi.fn();
    const onError = vi.fn();
    const text = Array.from({ length: 4 }, (_, i) => `This is sentence number ${i} and it has enough words to need its own piece.`).join(" ");
    c.speak(text, { onVoiceFallback, onError });
    synth.last.onerror?.({ error: "voice-unavailable" });
    expect(onVoiceFallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    const pieces = splitForSpeech(text);
    for (let i = 0; i < pieces.length; i += 1) {
      expect(synth.last.text).toBe(pieces[i]);
      expect(synth.last.voice).toBe(standard);
      synth.last.onstart?.();
      synth.last.onend?.();
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not fall back once the chosen voice has made a sound: a later failure is an error, and nothing is said twice", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onVoiceFallback = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();
    c.speak("Hello there.", { onVoiceFallback, onError, onEnd });
    synth.last.onstart?.();
    vi.advanceTimersByTime(4_000 + "Hello there.".length * 140);
    expect(onVoiceFallback).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].code).toBe("speech-stalled");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(1);
    expect(c.getVoice()).toBe(natural);
  });

  it("reports an error, with no loop, if the standard voice fails too", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onVoiceFallback = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();
    c.speak("Hello there.", { onVoiceFallback, onError, onEnd });
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS);
    expect(onVoiceFallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS);
    expect(onVoiceFallback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("speech-stalled");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(2);
    expect(c.isSpeaking()).toBe(false);
  });

  it("does not pretend to fall back when the chosen voice is the standard one anyway", () => {
    const synth = new FakeSynth();
    synth.voices = [natural];
    const c = createSpeechController({ synth, utteranceCtor: FakeUtterance });
    c.setVoice({ ...natural }); // the same voice, as a different object (some browsers hand out new ones on each call)
    const onVoiceFallback = vi.fn();
    const onError = vi.fn();
    c.speak("Hello there.", { onVoiceFallback, onError });
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS);
    expect(onVoiceFallback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(1);
  });

  it("stopping during the fallback still stops everything, once", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onEnd = vi.fn();
    c.speak("Hello there.", { onEnd });
    vi.advanceTimersByTime(SPEAK_START_TIMEOUT_MS); // fell back, standard voice now pending
    c.stopSpeaking();
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(synth.spoken).toHaveLength(2);
    expect(c.isSpeaking()).toBe(false);
  });

  it("destroy right after starting delivers nothing afterwards, not even a fallback", () => {
    const { synth, c } = setup();
    c.setVoice(natural);
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onVoiceFallback = vi.fn();
    c.speak("Hello there.", { onEnd, onError, onVoiceFallback });
    c.destroy();
    vi.advanceTimersByTime(120_000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onVoiceFallback).not.toHaveBeenCalled();
    expect(synth.spoken).toHaveLength(1);
  });
});
