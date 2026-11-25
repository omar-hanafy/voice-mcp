import { spawn, type ChildProcess } from 'node:child_process';

import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface RunOptions {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Collect stderr for the error message when the command fails. */
  captureStderr?: boolean;
}

const STDERR_LIMIT = 8_192;
const IS_WINDOWS = process.platform === 'win32';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly reason: 'failed' | 'aborted' | 'timeout' | 'spawn'
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * Runs one external process at a time (TTS generation or playback) and can stop it on demand.
 *
 * Invariant: at most one child is active. Stop requests terminate politely first and force-kill
 * after a grace period, so a TTS engine that ignores SIGTERM cannot keep talking after "stop".
 */
export class ProcessRunner {
  private active: { child: ChildProcess; label: string } | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly killGraceMs: () => number
  ) {}

  get activeLabel(): string | null {
    return this.active?.label ?? null;
  }

  run(command: string, args: readonly string[], options: RunOptions): Promise<void> {
    if (this.active) {
      this.logger.warn('Replacing a process that was still running', {
        previous: this.active.label,
        next: options.label,
      });
      this.stopActive('superseded');
    }

    return new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CommandError(`${options.label} aborted before start`, 'aborted'));
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          stdio: ['ignore', 'ignore', options.captureStderr ? 'pipe' : 'ignore'],
          windowsHide: true,
          // Own process group on POSIX so stop can reach helpers the command starts. On Windows
          // `detached` would open a console window instead; the tree is killed with taskkill.
          detached: !IS_WINDOWS,
        });
      } catch (error) {
        reject(new CommandError(`${options.label} could not start: ${errorMessage(error)}`, 'spawn'));
        return;
      }

      const current = { child, label: options.label };
      this.active = current;
      let stderr = '';
      let settled = false;
      let stopReason: 'aborted' | 'timeout' | null = null;

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
      });

      const timer =
        options.timeoutMs > 0
          ? setTimeout(() => {
              stopReason = 'timeout';
              this.terminate(child);
            }, options.timeoutMs)
          : null;

      const onAbort = () => {
        stopReason = 'aborted';
        this.terminate(child);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (error: CommandError | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.active === current) this.active = null;
        if (error) reject(error);
        else resolve();
      };

      child.once('error', (error) => {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        finish(
          new CommandError(
            missing ? `${options.label}: command not found (${command})` : `${options.label}: ${error.message}`,
            'spawn'
          )
        );
      });

      const settleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (stopReason) {
          finish(new CommandError(`${options.label} ${stopReason === 'timeout' ? 'timed out' : 'was stopped'}`, stopReason));
          return;
        }
        if (code === 0) {
          finish(null);
          return;
        }
        const detail = stderr.trim() ? ` - ${stderr.trim()}` : '';
        const how = signal ? `signal ${signal}` : `exit code ${code}`;
        finish(new CommandError(`${options.label} failed (${how})${detail}`, 'failed'));
      };

      // Settle on the child's own exit. 'close' would also wait for any helper process that
      // inherited stderr, which could block the queue indefinitely; allow a short grace period
      // for the last stderr chunks, then stop listening.
      child.once('exit', (code, signal) => {
        if (stopReason) {
          child.stderr?.destroy();
          settleExit(code, signal);
          return;
        }
        const grace = setTimeout(() => {
          child.stderr?.destroy();
          settleExit(code, signal);
        }, 250);
        child.once('close', () => {
          clearTimeout(grace);
          settleExit(code, signal);
        });
      });
    });
  }

  /** Stop whatever is running. Returns true when there was something to stop. */
  stopActive(reason: string): boolean {
    const active = this.active;
    if (!active) return false;
    this.logger.debug('Stopping active process', { label: active.label, reason });
    this.terminate(active.child);
    return true;
  }

  /**
   * Stop the child and everything it started: polite signal first, forced kill after the grace
   * period. POSIX children lead their own process group; Windows uses taskkill /T because
   * TerminateProcess does not reach child processes.
   */
  private terminate(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (IS_WINDOWS) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      } catch {
        // Fall back to the direct child below.
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      return;
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    signalGroup('SIGTERM');
    const force = setTimeout(() => signalGroup('SIGKILL'), Math.max(100, this.killGraceMs()));
    force.unref();
  }
}
