import { HttpError } from "@/lib/http";

/**
 * The client for the voice service (a small VM that runs Whisper and Piper for VeriBook and BusinessFlow; see
 * voice_service/ in the BusinessFlow repo). VeriBook uses it for one thing: turning a recording from the browser's
 * microphone into text, for browsers that cannot recognise speech themselves (Firefox, most of Safari).
 *
 * VOICE_SERVICE_URL and VOICE_SERVICE_API_KEY say where it is and which key this app holds (each app has its own, so one
 * can be revoked alone). With the URL unset, voiceConfigured() is false and the browser is told not to offer recording:
 * typing always works. When it is set and the service fails, the person is told so (503/502/504), never given an empty
 * or invented transcript, and the cause is logged.
 */
export const MAX_RECORDING_BYTES = 3 * 1024 * 1024; // 30 s of browser-recorded audio is a few hundred KB
const TRANSCRIBE_TIMEOUT_MS = 30_000;

function config(): { url: string; key: string } | null {
  const url = process.env.VOICE_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  const key = process.env.VOICE_SERVICE_API_KEY?.trim();
  if (!key) {
    console.error("voice: VOICE_SERVICE_URL is set but VOICE_SERVICE_API_KEY is not; voice transcription is off until it is");
    return null;
  }
  return { url, key };
}

export function voiceConfigured(): boolean {
  return config() !== null;
}

/**
 * What was said in a recording (English), possibly empty when nothing could be heard. Throws HttpError: 503 when voice is
 * not set up or the service is unreachable or busy, 504 when it took too long, 400/413 for a recording it refused,
 * 502 when it failed or answered something unreadable.
 */
export async function transcribeRecording(file: { bytes: Uint8Array; filename: string; mediaType: string }): Promise<string> {
  const cfg = config();
  if (!cfg) throw new HttpError(503, "voice transcription is not set up on this server");
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mediaType }), file.filename);
  form.append("language", "en");
  form.append("vad_filter", "true"); // a browser recording has silence at both ends
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/v1/stt`, { method: "POST", headers: { "X-API-Key": cfg.key }, body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") {
      console.error(`voice: the voice service at ${cfg.url} took longer than ${TRANSCRIBE_TIMEOUT_MS / 1000} s to transcribe`);
      throw new HttpError(504, "voice transcription took too long; try a shorter question or type it");
    }
    console.error(`voice: the voice service at ${cfg.url} is not reachable: ${err.message}`);
    throw new HttpError(503, "voice transcription is not available right now; type the question instead");
  }
  const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (res.status === 401 || res.status === 403) {
    console.error(`voice: the voice service at ${cfg.url} rejected VOICE_SERVICE_API_KEY (${res.status}); it must be one of VOICE_API_KEYS in /etc/voice.env on the voice VM`);
    throw new HttpError(502, "voice transcription is not working right now; type the question instead");
  }
  if (res.status === 429) throw new HttpError(503, "voice transcription is busy; try again in a moment or type the question");
  if (res.status === 400 || res.status === 413) throw new HttpError(res.status, "that recording could not be read; try again or type the question");
  if (!res.ok) {
    console.error(`voice: the voice service at ${cfg.url} answered ${res.status} to a transcription`);
    throw new HttpError(502, "voice transcription is not working right now; type the question instead");
  }
  if (typeof body?.text !== "string") {
    console.error(`voice: the voice service at ${cfg.url} returned an answer VeriBook does not understand`);
    throw new HttpError(502, "voice transcription is not working right now; type the question instead");
  }
  return body.text.trim();
}
