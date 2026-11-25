import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandError, type ProcessRunner } from '../src/audio/process-runner.js';
import type { AppPaths } from '../src/config/paths.js';
import { buildEffectiveConfig, parseControlState, type ProviderId } from '../src/config/settings.js';
import { providerOrder, speak, type EngineDeps } from '../src/speech/engine.js';
import { ProviderUnavailableError, type SpeechProvider, type SynthesisRequest } from '../src/speech/providers/types.js';
import type { StatusSink } from '../src/status/status.js';
import { silentLogger } from '../src/util/logger.js';
import { publishToNtfy } from '../src/notify/ntfy.js';
import { parseSettings } from '../src/config/settings.js';
import { tempPaths } from './helpers.js';

type Behavior = 'ok' | 'unavailable' | 'fail' | 'direct';

function fakeProvider(id: ProviderId, behavior: Behavior, calls: Array<{ id: string; voice: string | null }>): SpeechProvider {
  return {
    id,
    speaksDirectly: () => behavior === 'direct',
    async synthesize(request: SynthesisRequest) {
      calls.push({ id, voice: request.voiceOverride });
      if (behavior === 'unavailable') throw new ProviderUnavailableError(`${id} missing`);
      if (behavior === 'fail') throw new Error(`${id} crashed`);
      if (behavior === 'direct') return { kind: 'spoken', voice: id };
      const file = path.join(request.workDir, `${id}.wav`);
      await fsp.writeFile(file, 'audio');
      return { kind: 'file', file, voice: request.voiceOverride ?? id };
    },
  };
}

function fakeRunner(played: string[][], failWhen?: (args: string[]) => boolean): ProcessRunner {
  return {
    async run(_command: string, args: readonly string[]) {
      const list = [...args];
      played.push(list);
      if (failWhen?.(list)) throw new CommandError('player failed', 'failed');
    },
    stopActive: () => false,
    activeLabel: null,
  } as unknown as ProcessRunner;
}

const status: StatusSink = {
  setActivity: () => undefined,
  setQueueDepth: () => undefined,
  count: () => undefined,
  noteSpoken: () => undefined,
  noteStop: () => undefined,
  noteError: () => undefined,
  setSettingsError: () => undefined,
};

let paths: AppPaths;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ paths, cleanup } = await tempPaths());
});
afterEach(async () => {
  await cleanup();
});

function deps(providers: Record<ProviderId, SpeechProvider>, played: string[][], failWhen?: (args: string[]) => boolean): EngineDeps {
  return {
    paths,
    runner: fakeRunner(played, failWhen),
    status,
    logger: silentLogger,
    family: 'macos',
    find: () => '/usr/bin/x',
    env: {},
    providers,
  };
}

function config(rawSettings: Record<string, unknown>, control: Record<string, unknown> = {}) {
  return buildEffectiveConfig(rawSettings, parseControlState(control), Date.now());
}

describe('speech engine', () => {
  it('falls through unavailable and failing providers to the first that works', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const played: string[][] = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'unavailable', calls),
      piper: fakeProvider('piper', 'fail', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'ok', calls),
    };
    const outcome = await speak('hello', config({}), new AbortController().signal, deps(providers, played));
    expect(outcome).toEqual({ status: 'spoken', provider: 'system', voice: 'system' });
    expect(calls.map((c) => c.id)).toEqual(['kokoro', 'piper', 'system']);
    // Chime first, then the speech; the chime is not repeated for fallbacks.
    expect(played.map((args) => path.basename(args.at(-1)!))).toEqual(['chime.wav', 'system.wav']);
  });

  it('reports every provider error when nothing can speak', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'unavailable', calls),
      piper: fakeProvider('piper', 'fail', calls),
      system: fakeProvider('system', 'fail', calls),
      command: fakeProvider('command', 'fail', calls),
    };
    const outcome = await speak('hello', config({}), new AbortController().signal, deps(providers, []));
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toContain('kokoro: kokoro missing');
    expect(outcome.status === 'failed' && outcome.error).toContain('system: system crashed');
  });

  it('puts the preferred provider first and gives only it the voice override', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'ok', calls),
      piper: fakeProvider('piper', 'fail', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'ok', calls),
    };
    const cfg = config({}, { preferredProvider: 'piper', voiceOverride: 'amy' });
    expect(providerOrder(cfg)).toEqual(['piper', 'kokoro', 'system']);
    await speak('hello', cfg, new AbortController().signal, deps(providers, []));
    expect(calls).toEqual([
      { id: 'piper', voice: 'amy' },
      { id: 'kokoro', voice: null },
    ]);
  });

  it('plays the chime before a provider that speaks by itself', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const played: string[][] = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'ok', calls),
      piper: fakeProvider('piper', 'ok', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'direct', calls),
    };
    const outcome = await speak('hi', config({ providers: { order: ['command'] } }), new AbortController().signal, deps(providers, played));
    expect(outcome).toEqual({ status: 'spoken', provider: 'command', voice: 'command' });
    expect(played.map((args) => path.basename(args.at(-1)!))).toEqual(['chime.wav']);
  });

  it('retries without the chime when playing it fails', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const played: string[][] = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'ok', calls),
      piper: fakeProvider('piper', 'ok', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'ok', calls),
    };
    const outcome = await speak(
      'hi',
      config({ providers: { order: ['system'] } }),
      new AbortController().signal,
      deps(providers, played, (args) => args.at(-1)!.endsWith('chime.wav'))
    );
    expect(outcome.status).toBe('spoken');
    expect(played.map((args) => path.basename(args.at(-1)!))).toEqual(['chime.wav', 'system.wav']);
  });

  it('skips the chime when notifications are disabled and reports stops', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const played: string[][] = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'ok', calls),
      piper: fakeProvider('piper', 'ok', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'ok', calls),
    };
    await speak('hi', config({ notification: { enabled: false }, providers: { order: ['system'] } }), new AbortController().signal, deps(providers, played));
    expect(played.map((args) => path.basename(args.at(-1)!))).toEqual(['system.wav']);

    const aborted = new AbortController();
    aborted.abort('stopped');
    expect(await speak('hi', config({}), aborted.signal, deps(providers, []))).toEqual({ status: 'stopped' });
  });

  it('cleans up its temp files', async () => {
    const calls: Array<{ id: string; voice: string | null }> = [];
    const providers = {
      kokoro: fakeProvider('kokoro', 'ok', calls),
      piper: fakeProvider('piper', 'ok', calls),
      system: fakeProvider('system', 'ok', calls),
      command: fakeProvider('command', 'ok', calls),
    };
    await speak('hi', config({}), new AbortController().signal, deps(providers, []));
    expect(await fsp.readdir(paths.tempDir)).toEqual([]);
  });
});

describe('ntfy mirror', () => {
  const capture = () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('posts the line with title, priority, tag, and bearer token', async () => {
    const { calls, fetchImpl } = capture();
    const settings = parseSettings({ ntfy: { enabled: true, server: 'https://n.example/', topic: 'a b', token: 'tok', priority: 9 } }).ntfy;
    await publishToNtfy({ settings, text: 'hello', muted: false, logger: silentLogger, fetchImpl });
    expect(calls[0]!.url).toBe('https://n.example/a%20b');
    expect(calls[0]!.init.headers).toMatchObject({ Title: 'Voice', Priority: '5', Tags: 'speaker', Authorization: 'Bearer tok' });
  });

  it('trims long bodies when maxBodyChars is set and does nothing when disabled or topic-less', async () => {
    const { calls, fetchImpl } = capture();
    const trimmed = parseSettings({ ntfy: { enabled: true, topic: 't', maxBodyChars: 5 } }).ntfy;
    await publishToNtfy({ settings: trimmed, text: 'hello world', muted: true, logger: silentLogger, fetchImpl });
    expect(calls[0]!.init.body).toBe('hell…');
    await publishToNtfy({ settings: parseSettings({}).ntfy, text: 'x', muted: false, logger: silentLogger, fetchImpl });
    await publishToNtfy({ settings: parseSettings({ ntfy: { enabled: true } }).ntfy, text: 'x', muted: false, logger: silentLogger, fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it('never throws when the request fails', async () => {
    const settings = parseSettings({ ntfy: { enabled: true, topic: 't' } }).ntfy;
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(publishToNtfy({ settings, text: 'x', muted: false, logger: silentLogger, fetchImpl })).resolves.toBeUndefined();
  });
});
