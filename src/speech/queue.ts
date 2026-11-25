export type Job = (signal: AbortSignal) => Promise<void>;
export type DropPolicy = 'oldest' | 'newest';

export interface EnqueueResult {
  accepted: boolean;
  /** Older pending jobs discarded to make room. */
  dropped: number;
}

type Entry = { job: Job; controller: AbortController };

/**
 * A single linear queue: exactly one job runs at a time, in arrival order. `stopAll` aborts the
 * running job and discards everything pending.
 */
export class SpeechQueue {
  private pending: Entry[] = [];
  private running: Entry | null = null;
  private draining = false;

  constructor(
    private readonly limits: () => { maxDepth: number; dropPolicy: DropPolicy },
    private readonly onDepthChange: (depth: number) => void = () => undefined,
    private readonly onJobError: (error: unknown) => void = () => undefined
  ) {}

  get depth(): number {
    return this.pending.length;
  }

  isIdle(): boolean {
    return !this.draining && this.running === null && this.pending.length === 0;
  }

  enqueue(job: Job): EnqueueResult {
    const { maxDepth, dropPolicy } = this.limits();
    const capacity = Math.max(1, Math.floor(maxDepth));
    let dropped = 0;

    if (this.pending.length >= capacity) {
      if (dropPolicy === 'newest') return { accepted: false, dropped: 0 };
      while (this.pending.length >= capacity) {
        this.pending.shift()?.controller.abort('dropped');
        dropped += 1;
      }
    }

    this.pending.push({ job, controller: new AbortController() });
    this.onDepthChange(this.pending.length);
    void this.drain();
    return { accepted: true, dropped };
  }

  /** Abort the running job and clear the queue. Returns how many jobs were affected. */
  stopAll(reason: string): number {
    let affected = 0;
    if (this.running && !this.running.controller.signal.aborted) {
      this.running.controller.abort(reason);
      affected += 1;
    }
    for (const entry of this.pending) entry.controller.abort(reason);
    affected += this.pending.length;
    this.pending = [];
    this.onDepthChange(0);
    return affected;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        this.onDepthChange(this.pending.length);
        if (entry.controller.signal.aborted) continue;
        this.running = entry;
        try {
          await entry.job(entry.controller.signal);
        } catch (error) {
          this.onJobError(error);
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
