import type { ProviderId } from '../config/settings.js';
import { errorMessage } from '../util/errors.js';
import { writeJsonAtomic } from '../util/fs.js';
import type { Logger } from '../util/logger.js';

export type ActivityState = 'idle' | 'generating' | 'playing';

export interface StatusSnapshot {
  version: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  activity: {
    state: ActivityState;
    provider: ProviderId | null;
    voice: string | null;
    preview: string | null;
    since: number | null;
  };
  queueDepth: number;
  counters: {
    requests: number;
    spoken: number;
    droppedMuted: number;
    droppedGuardrails: number;
    droppedQueue: number;
    failed: number;
  };
  lastSpokenAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  settingsError: string | null;
}

export interface StatusSink {
  setActivity(state: ActivityState, provider?: ProviderId | null, voice?: string | null, preview?: string | null): void;
  setQueueDepth(depth: number): void;
  count(counter: keyof StatusSnapshot['counters']): void;
  noteSpoken(): void;
  noteStop(): void;
  noteError(message: string): void;
  setSettingsError(message: string | null): void;
}

export function initialStatus(version: string, now: number): StatusSnapshot {
  return {
    version,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    activity: { state: 'idle', provider: null, voice: null, preview: null, since: null },
    queueDepth: 0,
    counters: { requests: 0, spoken: 0, droppedMuted: 0, droppedGuardrails: 0, droppedQueue: 0, failed: 0 },
    lastSpokenAt: null,
    lastStopAt: null,
    lastError: null,
    lastErrorAt: null,
    settingsError: null,
  };
}

/**
 * In-memory broker status with a debounced, serialized writer to status.json. Mutators never
 * throw; a failed write is logged and the next change retries.
 */
export class StatusReporter implements StatusSink {
  private snapshot: StatusSnapshot;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly filePath: string,
    version: string,
    private readonly logger: Logger,
    private readonly debounceMs = 200
  ) {
    this.snapshot = initialStatus(version, Date.now());
  }

  get(): StatusSnapshot {
    return structuredClone(this.snapshot);
  }

  setActivity(state: ActivityState, provider: ProviderId | null = null, voice: string | null = null, preview: string | null = null): void {
    this.update((s) => {
      s.activity = { state, provider, voice, preview, since: state === 'idle' ? null : Date.now() };
    });
  }

  setQueueDepth(depth: number): void {
    this.update((s) => {
      s.queueDepth = depth;
    });
  }

  count(counter: keyof StatusSnapshot['counters']): void {
    this.update((s) => {
      s.counters[counter] += 1;
    });
  }

  noteSpoken(): void {
    this.update((s) => {
      s.counters.spoken += 1;
      s.lastSpokenAt = Date.now();
    });
  }

  noteStop(): void {
    this.update((s) => {
      s.lastStopAt = Date.now();
    });
  }

  noteError(message: string): void {
    this.update((s) => {
      s.counters.failed += 1;
      s.lastError = message;
      s.lastErrorAt = Date.now();
    });
  }

  setSettingsError(message: string | null): void {
    if (this.snapshot.settingsError === message) return;
    this.update((s) => {
      s.settingsError = message;
    });
  }

  /** Write the current snapshot now and wait for it (used at startup and shutdown). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  /** Final write; later changes (for example from jobs still unwinding) are not persisted. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private update(mutate: (snapshot: StatusSnapshot) => void): void {
    mutate(this.snapshot);
    this.snapshot.updatedAt = Date.now();
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.debounceMs);
    this.timer.unref();
  }

  private enqueueWrite(): Promise<void> {
    const write = this.chain.then(() => writeJsonAtomic(this.filePath, this.snapshot));
    this.chain = write.catch((error) => {
      this.logger.warn('Could not write status.json', { error: errorMessage(error) });
    });
    return this.chain;
  }
}
