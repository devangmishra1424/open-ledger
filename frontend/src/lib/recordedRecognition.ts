/**
 * Listening for browsers that cannot recognise speech themselves (Firefox, most of Safari): record the microphone with
 * MediaRecorder and have the server turn the recording into text (POST /api/voice/transcribe). It is built as a stand-in
 * for the browser's SpeechRecognition, with the same start/stop/events, so createSpeechController (speech.ts) drives it
 * exactly as it drives the native one and none of its timeout, error or "heard nothing" handling is repeated here.
 *
 * Differences from the native recogniser a person can notice: it cannot tell when they stopped talking, so they press the
 * microphone again to finish (or it stops at the controller's 30 s limit); and the words appear only after the
 * recording is sent, so a "Transcribing..." line is shown meanwhile.
 *
 * Browser objects are passed in (see RecordedDeps), so this runs under tests with fakes. Like speech.ts, what it is NOT
 * is a way to do anything but ask: the text becomes a typed question would.
 */
import type { RecognitionCtor, RecognitionEventLike, RecognitionLike } from "./speech";

export const TRANSCRIBING_PLACEHOLDER = "Transcribing…";
/** Below this a recording holds no speech (a recorder that was stopped the moment it started). */
export const MIN_RECORDING_BYTES = 1000;

export interface TrackLike {
  stop(): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
}
export interface BlobLike {
  size: number;
  type: string;
}
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: BlobLike }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
export interface RecordedDeps {
  /** navigator.mediaDevices.getUserMedia({ audio: true }). Rejects with the browser's DOMException. */
  getUserMedia(): Promise<StreamLike>;
  createRecorder(stream: StreamLike): RecorderLike;
  /** Joins the recorded pieces into one recording of the recorder's own type. */
  makeBlob(parts: BlobLike[], type: string): BlobLike;
  /** Sends the recording to the server and resolves with its text. Rejects with an error that may carry an HTTP `status`. */
  transcribe(recording: BlobLike): Promise<string>;
}

/** The speech.ts error code for a microphone failure (the words for each are in speech.ts's ERROR_WORDS). */
export function microphoneErrorCode(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "not-allowed";
  return "audio-capture"; // NotFoundError (no microphone), NotReadableError (in use), OverconstrainedError, or anything else
}

/** The speech.ts error code for a failed upload, or null when the server simply heard no speech (HTTP 422). */
export function transcriptionErrorCode(error: unknown): string | null {
  const status = (error as { status?: number } | null)?.status;
  if (status === 422) return null;
  if (status === 429 || status === 503) return "transcription-busy";
  return "transcription-unavailable";
}

const resultOf = (text: string, isFinal: boolean): RecognitionEventLike => ({ results: [{ isFinal, 0: { transcript: text } }] });

export function createRecordedRecognition(deps: RecordedDeps): RecognitionCtor {
  return class RecordedRecognition implements RecognitionLike {
    lang = "en-IN";
    interimResults = true;
    continuous = false;
    maxAlternatives = 1;
    onresult: ((event: RecognitionEventLike) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;

    private recorder: RecorderLike | null = null;
    private stream: StreamLike | null = null;
    private stopRequested = false; // stop() or abort() came before the microphone was ready
    private aborted = false;
    private ended = false;

    start(): void {
      deps.getUserMedia().then(
        (stream) => this.onMicrophone(stream),
        (error) => {
          this.onerror?.({ error: microphoneErrorCode(error) });
          this.end();
        },
      );
    }

    stop(): void {
      this.stopRequested = true;
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    }

    abort(): void {
      this.aborted = true;
      this.stop(); // still waiting for the microphone: onMicrophone sees the stop, releases it and ends
    }

    private onMicrophone(stream: StreamLike): void {
      this.stream = stream;
      if (this.stopRequested) {
        this.releaseMicrophone();
        this.end(); // stopped before it began: nothing was recorded, which the controller reports as "heard nothing"
        return;
      }
      const parts: BlobLike[] = [];
      const recorder = deps.createRecorder(stream);
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) parts.push(event.data);
      };
      recorder.onerror = () => {
        this.releaseMicrophone();
        this.onerror?.({ error: "audio-capture" });
        this.end();
      };
      recorder.onstop = () => {
        this.releaseMicrophone();
        if (this.aborted) return this.end();
        const recording = deps.makeBlob(parts, recorder.mimeType);
        if (recording.size < MIN_RECORDING_BYTES) return this.end();
        this.onresult?.(resultOf(TRANSCRIBING_PLACEHOLDER, false));
        deps.transcribe(recording).then(
          (text) => {
            this.onresult?.(resultOf(text, true));
            this.end();
          },
          (error) => {
            this.onresult?.(resultOf("", false)); // clears the placeholder, so it is never taken for a question
            const code = transcriptionErrorCode(error);
            if (code) this.onerror?.({ error: code });
            this.end();
          },
        );
      };
      try {
        recorder.start();
      } catch {
        // start() throws InvalidStateError when the recorder cannot run on this stream; no recording was made
        this.releaseMicrophone();
        this.onerror?.({ error: "audio-capture" });
        this.end();
        return;
      }
      // The controller waits up to 12 s for a first sound before giving up, which suits a recogniser that reports interim
      // words; this one reports none until the recording is sent, so an empty result tells it that listening has begun.
      this.onresult?.(resultOf("", false));
    }

    private releaseMicrophone(): void {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    private end(): void {
      if (this.ended) return;
      this.ended = true;
      this.onend?.();
    }
  };
}
