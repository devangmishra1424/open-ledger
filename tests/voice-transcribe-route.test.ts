import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/voice/transcribe/route";
import { RateLimiter } from "@/lib/rate-limit";
import { MAX_RECORDING_BYTES } from "@/lib/voice-client";

/**
 * POST /api/voice/transcribe against a real HTTP server standing in for the voice service, so what it sends (the key, the
 * file, the language) and what it makes of each answer (rejected key, busy, refused recording, unreadable answer, nothing
 * listening) is checked over a real connection. The route never has anything to say about approvals or payments: it returns
 * text for a question box.
 */

interface Seen {
  key: string | undefined;
  contentType: string | undefined;
  body: string;
}
let server: http.Server;
let url: string;
let seen: Seen[] = [];
let answer: { status: number; body: string } = { status: 200, body: JSON.stringify({ text: "why was this approved" }) };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ key: req.headers["x-api-key"] as string | undefined, contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString("latin1") });
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ip = 0;
const nextIp = () => `10.0.0.${++ip}`; // each test is its own caller, so the per-caller limit does not leak between tests

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: JSON.stringify({ text: "why was this approved" }) };
  vi.stubEnv("VOICE_SERVICE_URL", url);
  vi.stubEnv("VOICE_SERVICE_API_KEY", "veribook-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function post(file: File | null, caller = nextIp()) {
  const form = new FormData();
  if (file) form.append("file", file);
  return POST(new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form, headers: { "x-forwarded-for": caller } }), undefined as never);
}
const recording = (bytes = 5000, type = "audio/webm") => new File([new Uint8Array(bytes).fill(7)], "recording", { type });

describe("GET /api/voice/transcribe", () => {
  it("says whether this server can transcribe", async () => {
    expect(await (await GET(new Request("http://localhost/api/voice/transcribe"), undefined as never)).json()).toEqual({ enabled: true });
    vi.stubEnv("VOICE_SERVICE_URL", "");
    expect(await (await GET(new Request("http://localhost/api/voice/transcribe"), undefined as never)).json()).toEqual({ enabled: false });
  });

  it("says not enabled when there is a URL but no key, and why in the log", async () => {
    vi.stubEnv("VOICE_SERVICE_API_KEY", "");
    expect(await (await GET(new Request("http://localhost/api/voice/transcribe"), undefined as never)).json()).toEqual({ enabled: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("VOICE_SERVICE_API_KEY"));
  });
});

describe("POST /api/voice/transcribe: the edge", () => {
  it("is 503 when no voice service is configured", async () => {
    vi.stubEnv("VOICE_SERVICE_URL", "");
    const res = await post(recording());
    expect(res.status).toBe(503);
    expect(seen).toEqual([]);
  });

  it("needs a file", async () => {
    expect((await post(null)).status).toBe(400);
  });

  it("refuses an empty recording", async () => {
    expect((await post(new File([], "r", { type: "audio/webm" }))).status).toBe(400);
  });

  it("refuses a recording over the size cap without calling the service", async () => {
    const res = await post(recording(MAX_RECORDING_BYTES + 1));
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it.each(["application/pdf", "text/plain", "image/png", ""])("refuses a file that is not audio (%j)", async (type) => {
    const res = await post(new File([new Uint8Array(5000)], "x", { type }));
    expect(res.status).toBe(415);
    expect(seen).toEqual([]);
  });

  it.each(["audio/webm", "audio/ogg", "audio/mp4", "video/webm"])("accepts what a browser records as %s", async (type) => {
    expect((await post(recording(5000, type))).status).toBe(200);
  });

  it("limits how often one caller can use the shared voice service, and not other callers", async () => {
    const caller = nextIp();
    for (let i = 0; i < 12; i += 1) expect((await post(recording(), caller)).status).toBe(200);
    const over = await post(recording(), caller);
    expect(over.status).toBe(429);
    expect(seen).toHaveLength(12); // the refused one never reached the service
    expect((await post(recording(), nextIp())).status).toBe(200);
  });
});

describe("POST /api/voice/transcribe: what it sends and returns", () => {
  it("sends the recording with this app's key, English, and silence trimming, and returns the text", async () => {
    const res = await post(recording(5000, "audio/webm"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "why was this approved" });
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("veribook-key");
    expect(seen[0].contentType).toMatch(/^multipart\/form-data/);
    expect(seen[0].body).toContain('name="language"\r\n\r\nen');
    expect(seen[0].body).toContain('name="vad_filter"\r\n\r\ntrue');
    expect(seen[0].body).toContain("audio/webm");
  });

  it("keeps the text to the question box's length", async () => {
    answer = { status: 200, body: JSON.stringify({ text: "a".repeat(500) }) };
    const body = await (await post(recording())).json();
    expect(body.text).toHaveLength(300);
  });

  it("is 422 when nothing was heard", async () => {
    answer = { status: 200, body: JSON.stringify({ text: "   " }) };
    expect((await post(recording())).status).toBe(422);
  });
});

describe("POST /api/voice/transcribe: when the voice service fails", () => {
  it.each([
    [401, 502, "rejected VOICE_SERVICE_API_KEY"],
    [403, 502, "rejected VOICE_SERVICE_API_KEY"],
    [500, 502, "answered 500"],
    [503, 502, "answered 503"],
  ])("a %s from the service is a %s here, logged with the cause, and never shows the key or address", async (serviceStatus, expected, logged) => {
    answer = { status: serviceStatus, body: JSON.stringify({ detail: "internal detail veribook-key" }) };
    const res = await post(recording());
    expect(res.status).toBe(expected);
    const text = await res.text();
    expect(text).not.toContain("veribook-key");
    expect(text).not.toContain(url);
    expect(text).toMatch(/type the question/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(logged));
  });

  it("busy (429) is a 503 that says to try again", async () => {
    answer = { status: 429, body: JSON.stringify({ detail: "busy, try again" }) };
    const res = await post(recording());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/busy/);
  });

  it.each([400, 413])("a recording the service refused (%s) is passed on as that status", async (serviceStatus) => {
    answer = { status: serviceStatus, body: JSON.stringify({ detail: "cannot decode audio" }) };
    expect((await post(recording())).status).toBe(serviceStatus);
  });

  it.each([
    ["not json", "<html>bad gateway</html>"],
    ["no text field", JSON.stringify({ transcript: "x" })],
    ["text is not a string", JSON.stringify({ text: 5 })],
  ])("an unreadable answer (%s) is a 502, not an empty question", async (_name, body) => {
    answer = { status: 200, body };
    const res = await post(recording());
    expect(res.status).toBe(502);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("does not understand"));
  });

  it("a service nobody is listening at is a 503 that says to type, with the address in the log", async () => {
    vi.stubEnv("VOICE_SERVICE_URL", "http://127.0.0.1:1");
    const res = await post(recording());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/type the question/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:1"));
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit in a window, then again once the window has moved on", () => {
    let now = 1000;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, false]);
    expect(limiter.allow("b")).toBe(true); // another caller has its own quota
    now += 999;
    expect(limiter.allow("a")).toBe(false);
    now += 2; // the first two have left the window
    expect(limiter.allow("a")).toBe(true);
  });

  it("does not count a refused request against the caller", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    limiter.allow("a");
    for (let i = 0; i < 50; i += 1) limiter.allow("a"); // refused, not counted
    now += 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("forgets callers whose requests have all left the window once it tracks too many", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now, 3);
    ["a", "b", "c"].forEach((k) => limiter.allow(k));
    now += 5000;
    limiter.allow("d"); // over maxKeys: prunes a, b, c
    expect((limiter as unknown as { hits: Map<string, number[]> }).hits.size).toBe(1);
  });
});
