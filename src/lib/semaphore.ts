// FIFO async semaphore. Used by src/routes/public.ts to cap the
// number of concurrent inline /img renders, so a 30-image burst on
// a single-vCPU box doesn't fan out 30 simultaneous sharp pipelines.
//
// FIFO is important: the request that arrived first should get a
// slot first, otherwise late arrivals can starve early ones into
// the render-budget timeout. The queue is just an array shifted
// from the front.

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore: capacity must be a positive integer (got ${capacity})`);
    }
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    // Wait directly hands the slot to us — release() picks the next
    // waiter rather than incrementing available, so we don't
    // decrement on wake either.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }

  /** Snapshot of available + queued for diagnostics. */
  state(): { available: number; queued: number } {
    return { available: this.available, queued: this.waiters.length };
  }
}
