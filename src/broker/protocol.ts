/**
 * Broker wire protocol: one JSON object per line in each direction over a Unix socket (macOS,
 * Linux) or a named pipe (Windows). Each request gets exactly one response line.
 */
import { isPlainObject } from '../util/errors.js';

export type BrokerRequest =
  | { op: 'speak'; text: string; mirrorNtfy: boolean }
  | { op: 'stop' }
  | { op: 'reload' }
  | { op: 'ping' }
  | { op: 'shutdown' };

export type BrokerResponse =
  | { ok: true; version: string; pid: number; queued?: boolean }
  | { ok: false; error: string };

export function encodeRequest(request: BrokerRequest): string {
  if (request.op === 'speak') {
    // Only write the flag when it differs from the default to keep messages small.
    const wire: Record<string, unknown> = { op: 'speak', text: request.text };
    if (!request.mirrorNtfy) wire.ntfy = false;
    return `${JSON.stringify(wire)}\n`;
  }
  return `${JSON.stringify({ op: request.op })}\n`;
}

export function decodeRequest(line: string): BrokerRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  switch (parsed.op) {
    case 'speak':
      if (typeof parsed.text !== 'string') return null;
      // Only a literal false suppresses the mirror; anything else keeps the configured behavior.
      return { op: 'speak', text: parsed.text, mirrorNtfy: parsed.ntfy !== false };
    case 'stop':
    case 'reload':
    case 'ping':
    case 'shutdown':
      return { op: parsed.op };
    default:
      return null;
  }
}

export function encodeResponse(response: BrokerResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function decodeResponse(line: string): BrokerResponse | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isPlainObject(parsed) || typeof parsed.ok !== 'boolean') return null;
    if (parsed.ok) {
      return {
        ok: true,
        version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        ...(typeof parsed.queued === 'boolean' ? { queued: parsed.queued } : {}),
      };
    }
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'unknown error' };
  } catch {
    return null;
  }
}

/** Splits a byte stream into lines, tolerating chunk boundaries anywhere. */
export class LineReader {
  private buffer = '';

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) onLine(line);
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 1_000_000) this.buffer = '';
  }
}
