/**
 * Slows down password guessing: at most MAX_FAILURES failed sign-ins per client address within
 * WINDOW_MS, then 429 until the window passes. A successful sign-in clears the count.
 *
 * In memory, per server instance: correct for one instance (how this app is deployed today). With
 * several instances each keeps its own count, so the real limit is MAX_FAILURES x instances; a
 * shared store would be needed then. Bounded: at most MAX_TRACKED addresses are remembered, oldest
 * dropped first, so a flood of addresses cannot grow memory without limit.
 */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000;

interface Entry { failures: number; windowStart: number }
const entries = new Map<string, Entry>();

/** Seconds until this address may try again, or 0 if it may try now. */
export function retryAfterSeconds(address: string, now = Date.now()): number {
  const e = entries.get(address);
  if (!e || now - e.windowStart >= WINDOW_MS) return 0;
  return e.failures >= MAX_FAILURES ? Math.ceil((e.windowStart + WINDOW_MS - now) / 1000) : 0;
}

export function recordFailure(address: string, now = Date.now()): void {
  const e = entries.get(address);
  if (!e || now - e.windowStart >= WINDOW_MS) {
    entries.delete(address);
    entries.set(address, { failures: 1, windowStart: now });
    while (entries.size > MAX_TRACKED) entries.delete(entries.keys().next().value!);
    return;
  }
  e.failures += 1;
}

export function recordSuccess(address: string): void {
  entries.delete(address);
}

/** The caller's address as the hosting proxy reports it (first X-Forwarded-For hop), else "unknown". */
export function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0]?.trim()) || req.headers.get("x-real-ip") || "unknown";
}

/** For tests only. */
export function resetLoginThrottle(): void {
  entries.clear();
}
