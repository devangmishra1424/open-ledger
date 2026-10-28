import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIN_RECORDING_BYTES,
  TRANSCRIBING_PLACEHOLDER,
  createRecordedRecognition,
  microphoneErrorCode,
  transcriptionErrorCode,
  type BlobLike,
  type RecordedDeps,
  type RecorderLike,
  type StreamLike,
} from "../frontend/src/lib/recordedRecognition";
import { createSpeechController, describeSpeechError, type SpeechController } from "../frontend/src/lib/speech";

/**
 * Listening by recording, for browsers with no SpeechRecognition. The recogniser is driven by the REAL speech controller
 * (so its timers, "heard nothing" and one-onEnd rules apply) with the microphone, recorder and upload faked, which is what
 * lets the failure paths be tested: a denied or missing microphone, a stop before the microphone was ready, a recording with
 * nothing in it, a recorder that cannot start, and an upload that is refused, busy or broken. What this cannot show is a real
 * microphone and MediaRecorder; that part is a manual check.
 */

class FakeTrack {
  stopped = 0;
  stop() {
    this.stopped += 1;
  }
}
class FakeStream implements StreamLike {
  track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
}
class FakeRecorder implements RecorderLike {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: RecorderLike["ondataavailable"] = null;
  onstop: RecorderLike["onstop"] = null;
  onerror: RecorderLike["onerror"] = null;
  startThrows = false;
  start() {
    if (this.startThrows) throw new DOMException("cannot start", "InvalidStateError");
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  /** What the browser does while recording: hand over a piece of audio. */
  capture(bytes: number) {
    this.ondataavailable?.({ data: { size: bytes, type: this.mimeType } });
  }
}

interface Heard {
  finals: string[];
  errors: Array<{ code: string; message: string }>;
  interims: string[];
  ends: number;
}
interface Rig {
  controller: SpeechController;
  stream: FakeStream;
  recorder: FakeRecorder;
  transcribe: ReturnType<typeof vi.fn>;
  heard: Heard;
  /** The microphone permission is granted (the browser's prompt answered). */
  micReady: () => void;
  listen: () => boolean;
}

function rig({ getUserMedia, transcribe }: { getUserMedia?: () => Promise<StreamLike>; transcribe?: (b: BlobLike) => Promise<string> } = {}): Rig {
  const stream = new FakeStream();
  const recorder = new FakeRecorder();
  let micReady: () => void = () => {};
  const mic = new Promise<StreamLike>((resolve) => {
    micReady = () => resolve(stream);
  });
  const transcribeFn = vi.fn(transcribe ?? (async () => "why was this approved"));
  const deps: RecordedDeps = {
    getUserMedia: getUserMedia ?? (() => mic),
    createRecorder: () => recorder,
    makeBlob: (parts, type) => ({ size: parts.reduce((n, p) => n + p.size, 0), type }),
    transcribe: transcribeFn,
  };
  const controller = createSpeechController({ recognitionCtor: createRecordedRecognition(deps) });
  const heard: Heard = { finals: [], errors: [], interims: [], ends: 0 };
  const listen = () =>
    controller.listen({
      onFinal: (t) => heard.finals.push(t),
      onError: (e) => heard.errors.push(e),
      onInterim: (t) => heard.interims.push(t),
      onEnd: () => {
        heard.ends += 1;
      },
    });
  return { controller, stream, recorder, transcribe: transcribeFn, heard, micReady, listen };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recorded listening, end to end through the speech controller", () => {
  it("records, uploads on stop, and hands the text over as the finished question", async () => {
    const r = rig();
    expect(r.listen()).toBe(true);
    r.micReady();
    await flush();
    expect(r.recorder.state).toBe("recording");
    expect(r.controller.isListening()).toBe(true);

    r.recorder.capture(40_000);
    r.controller.stopListening();
    await flush();

    expect(r.transcribe).toHaveBeenCalledTimes(1);
    expect(r.transcribe.mock.calls[0][0]).toEqual({ size: 40_000, type: "audio/webm" });
    // "Transcribing…" is shown while the recording is being sent; then the words, as the controller reports every result
    expect(r.heard.interims).toEqual([TRANSCRIBING_PLACEHOLDER, "why was this approved"]);
    expect(r.heard.finals).toEqual(["why was this approved"]);
    expect(r.heard.errors).toEqual([]);
    expect(r.heard.ends).toBe(1);
    expect(r.stream.track.stopped).toBe(1); // the microphone is released
    expect(r.controller.isListening()).toBe(false);
  });

  it("does not give up after the controller's 12 s wait for a first sound (this recogniser reports none until it sends)", async () => {
    const r = rig();
    r.listen();
    r.micReady();
    await flush();
    r.recorder.capture(40_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.controller.isListening()).toBe(true);
    expect(r.recorder.state).toBe("recording");
  });

  it("stops by itself at the controller's 30 s limit and still sends what was said", async () => {
    const r = rig();
    r.listen();
    r.micReady();
    await flush();
    r.recorder.capture(60_000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.heard.finals).toEqual(["why was this approved"]);
    expect(r.heard.ends).toBe(1);
  });

  it("a recording with nothing in it is 'heard nothing' and is never uploaded", async () => {
    const r = rig();
    r.listen();
    r.micReady();
    await flush();
    r.recorder.capture(MIN_RECORDING_BYTES - 1);
    r.controller.stopListening();
    await flush();
    expect(r.transcribe).not.toHaveBeenCalled();
    expect(r.heard.finals).toEqual([]);
    expect(r.heard.errors.map((e) => e.code)).toEqual(["no-speech"]);
    expect(r.heard.ends).toBe(1);
    expect(r.stream.track.stopped).toBe(1);
  });

  it("pressing stop before the microphone is ready records nothing and still releases it", async () => {
    const r = rig();
    r.listen();
    r.controller.stopListening();
    r.micReady();
    await flush();
    expect(r.recorder.state).toBe("inactive");
    expect(r.transcribe).not.toHaveBeenCalled();
    expect(r.heard.errors.map((e) => e.code)).toEqual(["no-speech"]);
    expect(r.stream.track.stopped).toBe(1);
    expect(r.heard.ends).toBe(1);
  });

  it("leaving the page while recording releases the microphone and delivers nothing", async () => {
    const r = rig();
    r.listen();
    r.micReady();
    await flush();
    r.recorder.capture(40_000);
    r.controller.destroy();
    await flush();
    expect(r.stream.track.stopped).toBe(1);
    expect(r.transcribe).not.toHaveBeenCalled();
    expect(r.heard.finals).toEqual([]);
    expect(r.heard.errors).toEqual([]);
  });

  it.each([
    ["NotAllowedError", "not-allowed"],
    ["SecurityError", "not-allowed"],
    ["NotFoundError", "audio-capture"],
    ["NotReadableError", "audio-capture"],
  ])("a microphone failure (%s) is reported as %s, once, with words a person can act on", async (name, code) => {
    const r = rig({ getUserMedia: () => Promise.reject(new DOMException("mic", name)) });
    r.listen();
    await flush();
    expect(r.heard.errors).toEqual([{ code, message: describeSpeechError(code) }]);
    expect(r.heard.finals).toEqual([]);
    expect(r.heard.ends).toBe(1);
  });

  it("a recorder that cannot start is an error, with the microphone released", async () => {
    const r = rig();
    r.recorder.startThrows = true;
    r.listen();
    r.micReady();
    await flush();
    expect(r.heard.errors.map((e) => e.code)).toEqual(["audio-capture"]);
    expect(r.stream.track.stopped).toBe(1);
    expect(r.heard.ends).toBe(1);
    expect(r.controller.isListening()).toBe(false);
  });
});

describe("when the recording cannot be turned into text", () => {
  async function stoppedWith(transcribe: (b: BlobLike) => Promise<string>) {
    const r = rig({ transcribe });
    r.listen();
    r.micReady();
    await flush();
    r.recorder.capture(40_000);
    r.controller.stopListening();
    await flush();
    return r;
  }

  it.each([
    [503, "transcription-busy"],
    [429, "transcription-busy"],
    [502, "transcription-unavailable"],
    [504, "transcription-unavailable"],
    [0, "transcription-unavailable"], // the server could not be reached at all
  ])("an HTTP %s from the server is reported as %s, and the placeholder is never taken for a question", async (status, code) => {
    const r = await stoppedWith(() => Promise.reject(Object.assign(new Error("failed"), { status })));
    expect(r.heard.errors).toEqual([{ code, message: describeSpeechError(code) }]);
    expect(r.heard.finals).toEqual([]); // "Transcribing…" must not reach the question box as if it had been said
    expect(r.heard.ends).toBe(1);
    expect(r.stream.track.stopped).toBe(1);
  });

  it("a server that heard no speech (422) gives the ordinary 'I didn't hear anything'", async () => {
    const r = await stoppedWith(() => Promise.reject(Object.assign(new Error("none"), { status: 422 })));
    expect(r.heard.errors.map((e) => e.code)).toEqual(["no-speech"]);
    expect(r.heard.finals).toEqual([]);
    expect(r.heard.ends).toBe(1);
  });

  it("every transcription error code has words of its own, not the generic fallback", () => {
    const generic = describeSpeechError("some-unknown-code");
    for (const code of ["transcription-busy", "transcription-unavailable"]) {
      expect(describeSpeechError(code)).not.toBe(generic);
    }
  });
});

describe("error code mapping", () => {
  it("maps microphone failures", () => {
    expect(microphoneErrorCode({ name: "NotAllowedError" })).toBe("not-allowed");
    expect(microphoneErrorCode({ name: "NotFoundError" })).toBe("audio-capture");
    expect(microphoneErrorCode(null)).toBe("audio-capture");
  });
  it("maps upload failures, and a 422 to null (nothing was heard, which the controller already words)", () => {
    expect(transcriptionErrorCode({ status: 422 })).toBeNull();
    expect(transcriptionErrorCode({ status: 503 })).toBe("transcription-busy");
    expect(transcriptionErrorCode(new Error("x"))).toBe("transcription-unavailable");
  });
});
