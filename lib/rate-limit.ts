/**
 * A sliding-window limit on how often one caller may do something, kept in this process's memory: enough for the
 * single server VeriBook runs on (a second instance would each allow its own quota), and it forgets on restart.
 * Used where a request costs real work on a shared machine (voice transcription, which runs on the VM BusinessFlow
 * also uses), so one caller cannot use up everyone's share.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Keys tracked at once; past this, keys with nothing left in the window are dropped (bounds memory). */
    private readonly maxKeys = 5000,
  ) {}

  /** True and counts the request when `key` is under its limit; false (not counted) when it is over. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(t);
    return true;
  }

  private prune(t: number) {
    for (const [key, times] of this.hits) {
      if (times.every((at) => t - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}
