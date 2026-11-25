import { describe, expect, it } from 'vitest';

import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, LineReader } from '../src/broker/protocol.js';
import { compareVersions } from '../src/broker/client.js';
import { parseSettings } from '../src/config/settings.js';
import { Guardrails } from '../src/speech/guardrails.js';
import { SpeechQueue } from '../src/speech/queue.js';
import { normalizeSpeakText, previewText } from '../src/speech/text.js';

function guardrailSettings(overrides: Record<string, unknown> = {}) {
  return parseSettings({ guardrails: { panicMuteOnDrops: null, ...overrides } }).guardrails;
}

describe('Guardrails', () => {
  it('rejects empty text and overly long text', () => {
    const guardrails = new Guardrails();
    expect(guardrails.evaluate('   ', guardrailSettings(), 0)).toEqual({ allowed: false, reason: 'empty' });
    expect(guardrails.evaluate('too long', guardrailSettings({ maxCharsPerMessage: 3 }), 0)).toEqual({
      allowed: false,
      reason: 'too-long',
    });
  });

  it('normalizes whitespace in accepted text', () => {
    expect(new Guardrails().evaluate(' a \n\t b ', guardrailSettings(), 0)).toEqual({ allowed: true, text: 'a b' });
  });

  it('enforces the cooldown between accepted messages', () => {
    const guardrails = new Guardrails();
    const settings = guardrailSettings({ cooldownMs: 100, dedupeWindowMs: 0, maxMessagesPerMinute: 0 });
    expect(guardrails.evaluate('one', settings, 0).allowed).toBe(true);
    expect(guardrails.evaluate('two', settings, 50)).toEqual({ allowed: false, reason: 'cooldown' });
    expect(guardrails.evaluate('three', settings, 150).allowed).toBe(true);
  });

  it('drops exact repeats inside the dedupe window only', () => {
    const guardrails = new Guardrails();
    const settings = guardrailSettings({ cooldownMs: 0, dedupeWindowMs: 1_000, maxMessagesPerMinute: 0 });
    expect(guardrails.evaluate('same', settings, 0).allowed).toBe(true);
    expect(guardrails.evaluate('same', settings, 500)).toEqual({ allowed: false, reason: 'dedupe' });
    expect(guardrails.evaluate('same', settings, 1_500).allowed).toBe(true);
  });

  it('rate-limits with a refilling token bucket', () => {
    const guardrails = new Guardrails();
    const settings = guardrailSettings({ cooldownMs: 0, dedupeWindowMs: 0, maxMessagesPerMinute: 60, burst: 2 });
    expect(guardrails.evaluate('a', settings, 0).allowed).toBe(true);
    expect(guardrails.evaluate('b', settings, 0).allowed).toBe(true);
    expect(guardrails.evaluate('c', settings, 0)).toEqual({ allowed: false, reason: 'rate-limit' });
    expect(guardrails.evaluate('d', settings, 1_000).allowed).toBe(true);
  });

  it('trips the panic-mute fuse after too many drops and recovers later', () => {
    const guardrails = new Guardrails();
    const settings = parseSettings({
      guardrails: {
        cooldownMs: 0,
        dedupeWindowMs: 60_000,
        maxMessagesPerMinute: 0,
        panicMuteOnDrops: { enabled: true, threshold: 3, windowMs: 10_000, muteForMs: 5_000 },
      },
    }).guardrails;
    guardrails.evaluate('spam', settings, 0);
    for (let i = 1; i <= 3; i += 1) guardrails.evaluate('spam', settings, i);
    expect(guardrails.panicMutedUntil(10)).toBe(5_003);
    expect(guardrails.evaluate('fresh', settings, 100)).toEqual({ allowed: false, reason: 'panic-mute' });
    expect(guardrails.evaluate('fresh', settings, 6_000).allowed).toBe(true);
  });

  it('allows everything non-empty when disabled', () => {
    const guardrails = new Guardrails();
    const settings = guardrailSettings({ enabled: false, maxCharsPerMessage: 1 });
    expect(guardrails.evaluate('long text', settings, 0).allowed).toBe(true);
    expect(guardrails.evaluate('long text', settings, 0).allowed).toBe(true);
  });
});

describe('SpeechQueue', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('runs one job at a time in arrival order', async () => {
    const queue = new SpeechQueue(() => ({ maxDepth: 10, dropPolicy: 'oldest' }));
    const events: string[] = [];
    const gate = deferred();
    queue.enqueue(async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
    });
    queue.enqueue(async () => {
      events.push('b');
    });
    await Promise.resolve();
    expect(events).toEqual(['a:start']);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['a:start', 'a:end', 'b']);
    expect(queue.isIdle()).toBe(true);
  });

  it('drops the oldest pending job when full under the "oldest" policy', async () => {
    const queue = new SpeechQueue(() => ({ maxDepth: 1, dropPolicy: 'oldest' }));
    const ran: string[] = [];
    const gate = deferred();
    queue.enqueue(async () => gate.promise);
    queue.enqueue(async () => {
      ran.push('first');
    });
    expect(queue.enqueue(async () => void ran.push('second'))).toEqual({ accepted: true, dropped: 1 });
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(['second']);
  });

  it('rejects the new job when full under the "newest" policy', () => {
    const queue = new SpeechQueue(() => ({ maxDepth: 1, dropPolicy: 'newest' }));
    queue.enqueue(() => new Promise(() => undefined));
    queue.enqueue(async () => undefined);
    expect(queue.enqueue(async () => undefined)).toEqual({ accepted: false, dropped: 0 });
  });

  it('stopAll aborts the running job and clears the queue', async () => {
    const queue = new SpeechQueue(() => ({ maxDepth: 10, dropPolicy: 'oldest' }));
    let abortedReason: unknown = null;
    queue.enqueue(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortedReason = signal.reason;
            resolve();
          });
        })
    );
    let secondRan = false;
    queue.enqueue(async () => {
      secondRan = true;
    });
    await Promise.resolve();
    expect(queue.stopAll('stopped')).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(abortedReason).toBe('stopped');
    expect(secondRan).toBe(false);
    expect(queue.isIdle()).toBe(true);
  });

  it('keeps draining after a job throws', async () => {
    const errors: unknown[] = [];
    const queue = new SpeechQueue(() => ({ maxDepth: 10, dropPolicy: 'oldest' }), undefined, (e) => errors.push(e));
    let ran = false;
    queue.enqueue(async () => {
      throw new Error('boom');
    });
    queue.enqueue(async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(ran).toBe(true);
  });
});

describe('broker protocol', () => {
  it('round-trips requests and omits the default ntfy flag', () => {
    expect(encodeRequest({ op: 'speak', text: 'hi', mirrorNtfy: true })).toBe('{"op":"speak","text":"hi"}\n');
    const line = encodeRequest({ op: 'speak', text: 'hi', mirrorNtfy: false }).trim();
    expect(decodeRequest(line)).toEqual({ op: 'speak', text: 'hi', mirrorNtfy: false });
    for (const op of ['stop', 'reload', 'ping', 'shutdown'] as const) {
      expect(decodeRequest(encodeRequest({ op }).trim())).toEqual({ op });
    }
  });

  it('only suppresses the mirror for a literal false', () => {
    expect(decodeRequest('{"op":"speak","text":"x","ntfy":0}')).toEqual({ op: 'speak', text: 'x', mirrorNtfy: true });
  });

  it('rejects malformed requests', () => {
    expect(decodeRequest('not json')).toBeNull();
    expect(decodeRequest('{"op":"speak"}')).toBeNull();
    expect(decodeRequest('{"op":"format-disk"}')).toBeNull();
  });

  it('round-trips responses', () => {
    const ok = { ok: true as const, version: '1.2.3', pid: 42, queued: true };
    expect(decodeResponse(encodeResponse(ok).trim())).toEqual(ok);
    expect(decodeResponse(encodeResponse({ ok: false, error: 'no' }).trim())).toEqual({ ok: false, error: 'no' });
    expect(decodeResponse('OK')).toBeNull();
  });

  it('reassembles lines split across chunks', () => {
    const reader = new LineReader();
    const lines: string[] = [];
    reader.push('{"a":', (l) => lines.push(l));
    reader.push('1}\n\n{"b":2}\n{"c"', (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('0.4.3', '0.5.0')).toBe(-1);
    expect(compareVersions('0.5.0', '0.0.0-dev')).toBe(1);
  });
});

describe('text helpers', () => {
  it('normalizes whitespace and builds bounded previews', () => {
    expect(normalizeSpeakText('  a\r\n b  ')).toBe('a b');
    expect(normalizeSpeakText(42)).toBe('');
    expect(previewText('hello world', 5)).toBe('hell…');
    expect(previewText('hi', 5)).toBe('hi');
    expect(previewText('hi', 0)).toBe('');
  });
});
