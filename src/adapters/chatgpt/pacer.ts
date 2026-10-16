/**
 * Spaces requests to ChatGPT's API. It answers 429 to a run of quick requests
 * (docs/platforms-chatgpt.md, section 5), so the gap doubles after each 429, up
 * to `maxMs`, and halves again after `calmAfter` answers without one.
 */
export class Pacer {
  private gap: number;
  private last = Number.NEGATIVE_INFINITY;
  private calm = 0;

  constructor(
    private readonly baseMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly maxMs = 16_000,
    private readonly calmAfter = 20,
  ) {
    this.gap = baseMs;
  }

  /** The current gap between requests. */
  get gapMs(): number {
    return this.gap;
  }

  /** Waits until the gap since the last request has passed. */
  async turn(): Promise<void> {
    const wait = this.last + this.gap - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }

  /** Widens the gap after a 429, narrows it back after a calm stretch. */
  observe(status: number): void {
    if (status === 429) {
      this.gap = Math.min(this.maxMs, Math.max(this.gap * 2, 1000));
      this.calm = 0;
    } else if (++this.calm >= this.calmAfter && this.gap > this.baseMs) {
      this.gap = Math.max(this.baseMs, this.gap / 2);
      this.calm = 0;
    }
  }
}
