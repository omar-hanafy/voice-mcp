import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { request, sendSpeak } from '../src/broker/client.js';
import { startBroker, type RunningBroker } from '../src/broker/server.js';
import type { AppPaths } from '../src/config/paths.js';
import { osFamily } from '../src/platform.js';
import { silentLogger } from '../src/util/logger.js';
import { readJsonLines, tempPaths, waitFor, writeFakeTool } from './helpers.js';

interface Harness {
  paths: AppPaths;
  root: string;
  ttsLog: string;
  playerLog: string;
  ntfyCalls: Array<{ url: string; headers: Record<string, string>; body: string }>;
  broker: RunningBroker;
  cleanup: () => Promise<void>;
}

async function writeSettings(paths: AppPaths, settings: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(paths.dataDir, { recursive: true });
  await fsp.writeFile(paths.settingsPath, JSON.stringify(settings, null, 2));
}

function fakeSettings(root: string, ttsLog: string, playerLog: string, playerSleepMs = 0) {
  const tts = writeFakeTool(root, 'tts', ttsLog);
  const player = writeFakeTool(root, 'player', playerLog);
  return {
    audio: {
      player: process.execPath,
      playerArgs: playerSleepMs > 0 ? [player, '--sleep', String(playerSleepMs)] : [player],
      killGraceMs: 200,
    },
    providers: {
      order: ['command'],
      command: { command: process.execPath, args: [tts, '--out', '{outFile}', '--voice', '{voice}', '{text}'] },
    },
    guardrails: { cooldownMs: 0, dedupeWindowMs: 0, maxMessagesPerMinute: 0 },
    ntfy: { enabled: true, topic: 'test-topic', server: 'https://ntfy.example' },
    logging: { file: false },
  };
}

async function setup(playerSleepMs = 0, extra: Record<string, unknown> = {}): Promise<Harness> {
  const { paths, root, cleanup } = await tempPaths();
  const ttsLog = path.join(root, 'tts.log');
  const playerLog = path.join(root, 'player.log');
  await writeSettings(paths, { ...fakeSettings(root, ttsLog, playerLog, playerSleepMs), ...extra });
  const ntfyCalls: Harness['ntfyCalls'] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    ntfyCalls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  const broker = await startBroker({ paths, idleMs: 60_000, fetchImpl });
  if (!broker) throw new Error('broker did not start');
  return {
    paths,
    root,
    ttsLog,
    playerLog,
    ntfyCalls,
    broker,
    cleanup: async () => {
      await broker.shutdown('test');
      await cleanup();
    },
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

describe('broker', () => {
  it('synthesizes, plays the chime then the speech, and mirrors to ntfy', async () => {
    harness = await setup();
    const h = harness;
    expect(await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Build  finished.' })).toBe(true);

    await waitFor(() => readJsonLines(h.playerLog).length >= 2);
    const tts = readJsonLines(h.ttsLog);
    expect(tts).toHaveLength(1);
    expect(tts[0]!.args.at(-1)).toBe('Build finished.');

    const played = readJsonLines(h.playerLog).map((entry) => path.basename(entry.args.at(-1)!));
    expect(played).toEqual(['chime.wav', 'command.wav']);

    await waitFor(() => h.ntfyCalls.length === 1);
    expect(h.ntfyCalls[0]!.url).toBe('https://ntfy.example/test-topic');
    expect(h.ntfyCalls[0]!.headers.Tags).toBe('speaker');
    expect(h.ntfyCalls[0]!.body).toBe('Build finished.');

    await waitFor(() => h.broker.service.isIdle());
    const status = JSON.parse(await fsp.readFile(h.paths.statusPath, 'utf8').catch(() => '{}'));
    await waitFor(async () => JSON.parse(await fsp.readFile(h.paths.statusPath, 'utf8')).counters.spoken === 1);
    expect(status).toBeTypeOf('object');
  });

  it('stays silent while muted but still mirrors with the mute tag', async () => {
    harness = await setup();
    const h = harness;
    await fsp.writeFile(h.paths.statePath, JSON.stringify({ mute: true }));
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Quiet please.' });
    await waitFor(() => h.ntfyCalls.length === 1);
    expect(h.ntfyCalls[0]!.headers.Tags).toBe('mute');
    await waitFor(() => h.broker.service.isIdle());
    expect(readJsonLines(h.ttsLog)).toEqual([]);
  });

  it('skips the mirror for --no-ntfy callers', async () => {
    harness = await setup();
    const h = harness;
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'From cron.', mirrorNtfy: false });
    await waitFor(() => readJsonLines(h.playerLog).length >= 2);
    expect(h.ntfyCalls).toEqual([]);
  });

  it('stop kills playback immediately and clears the queue', async () => {
    harness = await setup(10_000);
    const h = harness;
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'First long line.' });
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Second line.' });
    await waitFor(() => readJsonLines(h.playerLog).length >= 1);

    const started = Date.now();
    expect((await request(h.paths.brokerEndpoint, { op: 'stop' }))?.ok).toBe(true);
    await waitFor(() => h.broker.service.isIdle(), 3_000);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(readJsonLines(h.ttsLog).map((entry) => entry.args.at(-1))).toEqual(['First long line.']);
  });

  it('muting during speech stops it', async () => {
    harness = await setup(10_000);
    const h = harness;
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Talking.' });
    await waitFor(() => readJsonLines(h.playerLog).length >= 1);
    await fsp.writeFile(h.paths.statePath, JSON.stringify({ mute: true }));
    await request(h.paths.brokerEndpoint, { op: 'reload' });
    await waitFor(() => h.broker.service.isIdle(), 3_000);
  });

  it('applies the voice override only to the first provider', async () => {
    harness = await setup();
    const h = harness;
    await fsp.writeFile(h.paths.statePath, JSON.stringify({ voiceOverride: 'robot' }));
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'With voice.' });
    await waitFor(() => readJsonLines(h.ttsLog).length === 1);
    const args = readJsonLines(h.ttsLog)[0]!.args;
    expect(args[args.indexOf('--voice') + 1]).toBe('robot');
  });

  it('keeps the last valid settings when the file becomes invalid', async () => {
    harness = await setup();
    const h = harness;
    await fsp.writeFile(h.paths.settingsPath, '{ "audio": { oops ');
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Still works.' });
    await waitFor(() => readJsonLines(h.playerLog).length >= 2);
    await waitFor(async () => JSON.parse(await fsp.readFile(h.paths.statusPath, 'utf8')).settingsError !== null);
  });

  it('refuses to start a second broker on the same endpoint', async () => {
    harness = await setup();
    expect(await startBroker({ paths: harness.paths, idleMs: 60_000 })).toBeNull();
  });

  it('a broker that loses the start-up race leaves the live broker\'s audio alone', async () => {
    harness = await setup();
    const h = harness;
    // Slow synthesis: the second broker starts while the first is still writing audio.
    const settings = JSON.parse(await fsp.readFile(h.paths.settingsPath, 'utf8'));
    const [script, ...rest] = settings.providers.command.args as string[];
    settings.providers.command.args = [script, '--delay', '800', ...rest];
    await fsp.writeFile(h.paths.settingsPath, JSON.stringify(settings));
    await sendSpeak({ paths: h.paths, logger: silentLogger, text: 'Racing line.' });
    await waitFor(() => readJsonLines(h.ttsLog).length === 1);
    expect(await startBroker({ paths: h.paths, idleMs: 60_000 })).toBeNull();
    await waitFor(() => readJsonLines(h.playerLog).length >= 2, 5_000);
    await waitFor(() => h.broker.service.isIdle(), 5_000);
    await waitFor(async () => JSON.parse(await fsp.readFile(h.paths.statusPath, 'utf8')).counters.spoken === 1);
  });

  it('answers ping with its version and removes its socket on shutdown', async () => {
    harness = await setup();
    const h = harness;
    const ping = await request(h.paths.brokerEndpoint, { op: 'ping' });
    expect(ping).toMatchObject({ ok: true, pid: process.pid });
    await h.broker.shutdown('test');
    expect(await request(h.paths.brokerEndpoint, { op: 'ping' }, 300)).toBeNull();
    if (osFamily() !== 'windows') expect(fs.existsSync(h.paths.brokerEndpoint)).toBe(false);
  });
});

describe('client without a broker', () => {
  let ctx: Awaited<ReturnType<typeof tempPaths>>;
  beforeEach(async () => {
    ctx = await tempPaths();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns null from request when nothing listens', async () => {
    expect(await request(ctx.paths.brokerEndpoint, { op: 'ping' }, 300)).toBeNull();
  });
});
