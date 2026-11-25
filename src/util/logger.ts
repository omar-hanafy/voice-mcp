import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from '../config/settings.js';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [unserializable meta]';
  }
}

/**
 * Line logger that writes to stderr (never stdout: stdout carries the MCP protocol and hook
 * responses) and optionally appends to a file. Logging never throws.
 */
export class AppLogger implements Logger {
  private level: LogLevel;
  private filePath: string | null;
  private readonly stderr: boolean;
  private readonly component: string;

  constructor(options: { component: string; level?: LogLevel; filePath?: string | null; stderr?: boolean }) {
    this.component = options.component;
    this.level = options.level ?? 'info';
    this.filePath = options.filePath ?? null;
    this.stderr = options.stderr ?? true;
  }

  configure(options: { level?: LogLevel; filePath?: string | null }): void {
    if (options.level) this.level = options.level;
    if (options.filePath !== undefined) this.filePath = options.filePath;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const line = `${new Date().toISOString()} [voice-mcp:${this.component}] ${level.toUpperCase()} ${message}${formatMeta(meta)}\n`;
    if (this.stderr) {
      try {
        process.stderr.write(line);
      } catch {
        // stderr may be closed (detached broker); file logging still applies.
      }
    }
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        // Synchronous append keeps lines ordered across components and survives abrupt exits.
        fs.appendFileSync(this.filePath, line, 'utf8');
      } catch {
        // Logging must never break speech.
      }
    }
  }
}
