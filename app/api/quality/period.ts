import { HttpError } from "@/lib/http";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const DAY_MS = 864e5;

/** The report period from ?from&to (YYYY-MM-DD, UTC days), defaulting to the last 30 days; at most a year. */
export function qualityPeriod(url: URL | Record<string, unknown>): { from: string; to: string } {
  const get = (k: string) => (url instanceof URL ? url.searchParams.get(k) : typeof url[k] === "string" ? (url[k] as string) : null);
  const to = get("to") ?? new Date().toISOString().slice(0, 10);
  const from = get("from") ?? new Date(Date.parse(to) - 29 * DAY_MS).toISOString().slice(0, 10);
  for (const [k, v] of [["from", from], ["to", to]]) {
    if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${k} must be a date as YYYY-MM-DD`);
  }
  if (from > to) throw new HttpError(400, "from must be on or before to");
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) throw new HttpError(400, "the period can be at most a year");
  return { from, to };
}
