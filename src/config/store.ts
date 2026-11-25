import fs from 'node:fs';

import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import { ensureDataDir, readControlState, readRawSettings } from './files.js';
import type { AppPaths } from './paths.js';
import { buildEffectiveConfig, parseControlState, type EffectiveConfig } from './settings.js';

export type ConfigListener = (next: EffectiveConfig, previous: EffectiveConfig) => void;

const WATCH_DEBOUNCE_MS = 75;
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Live view of settings.jsonc and state.json for the long-running broker.
 *
 * - `reload()` guarantees the caller sees a disk read that started after the call, while
 *   overlapping requests share one read.
 * - A directory watcher reloads after edits; the broker also reloads before every message, so a
 *   missed watch event only delays a change until the next line.
 * - An invalid settings file keeps the last good settings instead of silently reverting to
 *   defaults mid-session. The error is surfaced through `settingsError`.
 */
export class ConfigStore {
  private current: EffectiveConfig;
  private lastGoodRawSettings: unknown = {};
  private settingsErrorValue: string | null = null;
  private readonly listeners = new Set<ConfigListener>();
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private muteTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger
  ) {
    this.current = buildEffectiveConfig({}, parseControlState({}), Date.now());
  }

  async start(): Promise<void> {
    try {
      await ensureDataDir(this.paths);
    } catch (error) {
      this.logger.warn('Could not prepare the data directory', { error: errorMessage(error) });
    }
    await this.reload();
    this.startWatching();
  }

  get(): EffectiveConfig {
    return this.current;
  }

  get settingsError(): string | null {
    return this.settingsErrorValue;
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.inflight) {
      this.inflight = this.readAndApply().finally(() => {
        this.inflight = null;
      });
      return this.inflight;
    }
    // A read is already running but may have started before this request; queue exactly one
    // follow-up read that every overlapping caller shares.
    if (!this.queued) {
      this.queued = this.inflight.then(() => {
        this.queued = null;
        return this.reload();
      });
    }
    return this.queued;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.listeners.clear();
  }

  private async readAndApply(): Promise<void> {
    const [raw, control] = await Promise.all([readRawSettings(this.paths), readControlState(this.paths)]);

    if (raw.error) {
      if (raw.error !== this.settingsErrorValue) {
        this.logger.warn('Settings file is invalid; keeping the last valid settings', { error: raw.error });
      }
      this.settingsErrorValue = raw.error;
    } else {
      this.settingsErrorValue = null;
      this.lastGoodRawSettings = raw.value;
    }

    const next = buildEffectiveConfig(this.lastGoodRawSettings, control, Date.now());
    const previous = this.current;
    this.scheduleMuteExpiry(next);
    if (JSON.stringify(next) === JSON.stringify(previous)) return;

    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        this.logger.error('Config listener failed', { error: errorMessage(error) });
      }
    }
  }

  private scheduleMuteExpiry(config: EffectiveConfig): void {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    if (config.mutedUntil === null || this.disposed) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, config.mutedUntil - Date.now()) + 50);
    this.muteTimer = setTimeout(() => void this.reload(), wait);
    this.muteTimer.unref();
  }

  private startWatching(): void {
    if (this.disposed || this.watcher) return;
    try {
      // Watch the directory, not the files: atomic writes replace the file (a rename), which
      // would silently detach a per-file watcher on macOS and Linux.
      this.watcher = fs.watch(this.paths.dataDir, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : '';
        if (name && name !== 'settings.jsonc' && name !== 'state.json') return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.reload();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', (error) => {
        this.logger.warn('Settings watcher failed; changes apply on the next message', {
          error: errorMessage(error),
        });
        this.watcher?.close();
        this.watcher = null;
      });
      this.watcher.unref();
    } catch (error) {
      this.logger.warn('Cannot watch the data directory; changes apply on the next message', {
        error: errorMessage(error),
      });
    }
  }
}
