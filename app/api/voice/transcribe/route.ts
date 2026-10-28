import { handle, HttpError } from "@/lib/http";
import { RateLimiter } from "@/lib/rate-limit";
import { MAX_RECORDING_BYTES, transcribeRecording, voiceConfigured } from "@/lib/voice-client";

export const maxDuration = 60;

const MAX_QUESTION_CHARS = 300; // the ask box's own limit
// The voice service is shared with BusinessFlow and does one recording at a time, so one caller's quota is small.
const limiter = new RateLimiter(12, 60_000);

/**
 * GET /api/voice/transcribe: { enabled } -- whether this server can turn a recording into text. The page asks once, in a
 * browser that cannot recognise speech itself, and offers the microphone only when this says true.
 *
 * POST /api/voice/transcribe: multipart/form-data with `file`, one short audio recording from the browser (MediaRecorder:
 * webm, ogg or mp4; up to 3 MB). Returns { text }. The text is only ever used as a typed question would be: the voice
 * feature reads, it cannot approve or pay.
 *
 * Errors: 400/413 unreadable or too large a recording, 415 not audio, 422 nothing heard, 429 too many recordings from one
 * caller, 502/503/504 the voice service failed, is busy or off, or took too long (see lib/voice-client.ts).
 */
export const GET = handle("GET /api/voice/transcribe", async () => Response.json({ enabled: voiceConfigured() }));

export const POST = handle("POST /api/voice/transcribe", async (req) => {
  if (!voiceConfigured()) throw new HttpError(503, "voice transcription is not set up on this server");
  // Behind the reverse proxy the caller is the first address in X-Forwarded-For; direct calls (local development) share one bucket.
  const caller = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
  if (!limiter.allow(caller)) throw new HttpError(429, "too many recordings just now; wait a minute or type the question");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES + 4096) throw new HttpError(413, "the recording is too large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "send the recording as multipart/form-data with a `file` field");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "a `file` field with the recording is required");
  if (file.size === 0) throw new HttpError(400, "the recording is empty");
  if (file.size > MAX_RECORDING_BYTES) throw new HttpError(413, "the recording is too large");
  // MediaRecorder labels audio-only recordings audio/*; some Chromium builds say video/webm for the same bytes.
  if (!file.type.startsWith("audio/") && file.type !== "video/webm") throw new HttpError(415, "the file is not audio");

  const text = await transcribeRecording({ bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name || "recording", mediaType: file.type });
  if (!text) throw new HttpError(422, "no speech was heard in the recording");
  console.info(`POST /api/voice/transcribe: ${file.size} bytes (${file.type}) -> ${text.length} characters`);
  return Response.json({ text: text.slice(0, MAX_QUESTION_CHARS) });
});
