/**
 * End-to-end tests against the built bundle (plugin/dist/voice-mcp.mjs), the artifact hosts
 * actually run. They use a fake TTS engine and a fake player so they are silent and run the
 * same on macOS, Windows, and Linux. Run `npm run build` first; `npm run check` does.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { request } from '../src/broker/client.js';
import type { AppPaths } from '../src/config/paths.js';
import { BUNDLE, REPO_ROOT, readJsonLines, tempPaths, waitFor, writeFakeTool } from './helpers.js';

const bundleExists = fs.existsSync(BUNDLE);
const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };

let paths: AppPaths;
let root: string;
let cleanup: () => Promise<void>;
let ttsLog: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  ({ paths, root, cleanup } = await tempPaths());
  ttsLog = path.join(root, 'tts.log');
  const tts = writeFakeTool(root, 'tts', ttsLog);
  const player = writeFakeTool(root, 'player', path.join(root, 'player.log'));
  await fsp.mkdir(paths.dataDir, { recursive: true });
  await fsp.writeFile(
    paths.settingsPath,
    JSON.stringify({
      audio: { player: process.execPath, playerArgs: [player] },
      providers: { order: ['command'], command: { command: process.execPath, args: [tts, '--out', '{outFile}', '{text}'] } },
      guardrails: { cooldownMs: 0 },
    })
  );
  env = { ...process.env, VOICE_MCP_HOME: paths.dataDir, VOICE_MCP_BROKER_IDLE_MS: '20000' };
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  // Wait for the detached broker to exit; it writes status and logs while shutting down.
  const ping = await request(paths.brokerEndpoint, { op: 'ping' }, 500);
  if (ping?.ok) {
    await request(paths.brokerEndpoint, { op: 'shutdown' }, 1_000);
    await waitFor(() => !isAlive(ping.pid), 5_000).catch(() => undefined);
  }
  await cleanup();
});

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [BUNDLE, ...args], { env, input, encoding: 'utf8', cwd: root, timeout: 20_000 });
}

const spokenTexts = () => readJsonLines(ttsLog).map((entry) => entry.args.at(-1));

describe.skipIf(!bundleExists)('bundled runtime', () => {
  it('reports the package version', () => {
    expect(run(['version']).stdout.trim()).toBe(version);
  });

  it('speaks from the CLI through a broker it starts on demand', async () => {
    const result = run(['speak', 'Deploy', 'finished.']);
    expect(result.status).toBe(0);
    await waitFor(() => spokenTexts().includes('Deploy finished.'));
    const status = JSON.parse(run(['status', '--json']).stdout);
    expect(status.broker).toMatchObject({ running: true, version });
  });

  it('serves the speak tool over MCP stdio from any working directory', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, 'mcp'],
      env: env as Record<string, string>,
      cwd: root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'voice-mcp', version });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['speak']);
      const started = Date.now();
      const result = await client.callTool({ name: 'speak', arguments: { text: 'Tests are green.' } });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.content).toEqual([]);
      await waitFor(() => spokenTexts().includes('Tests are green.'));
    } finally {
      await client.close();
    }
  });

  it('speaks a cleaned summary for a Claude Code Stop hook and answers with an empty object', async () => {
    const payload = {
      hook_event_name: 'Stop',
      session_id: 's',
      last_assistant_message: '## Summary\nFixed the crash in `/Users/me/project/src/parser.ts`. All 12 tests pass.',
    };
    const result = run(['hook'], JSON.stringify(payload));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{}\n');
    await waitFor(() => spokenTexts().length === 1);
    expect(spokenTexts()[0]).toBe('Fixed the crash in parser.ts. All 12 tests pass.');
  });

  it('answers Antigravity hooks with an allow decision', async () => {
    const payload = { conversationId: 'c', hookEventName: 'Stop', fullyIdle: true, terminationReason: 'COMPLETED' };
    const result = run(['hook'], JSON.stringify(payload));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"decision":"allow"}\n');
    await waitFor(() => spokenTexts().length === 1);
  });

  it('announces a question before the question tool opens', async () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which database should we use?' }] },
    };
    expect(run(['hook'], JSON.stringify(payload)).stdout).toBe('{}\n');
    await waitFor(() => spokenTexts()[0] === 'The agent needs your input. Which database should we use?');
  });

  it('never fails a hook, even on garbage input', () => {
    const result = run(['hook'], 'not json at all');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{}\n');
  });

  it('controls mute state from the CLI', () => {
    expect(run(['mute']).status).toBe(0);
    expect(JSON.parse(run(['status', '--json']).stdout).muted).toBe(true);
    expect(run(['toggle-mute']).stdout.trim()).toBe('unmuted');
    expect(run(['mute-for', '5']).status).toBe(0);
    expect(JSON.parse(run(['status', '--json']).stdout).mutedUntil).toBeGreaterThan(Date.now());
    expect(run(['set-provider', 'say']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).preferredProvider).toBe('system');
    expect(run(['set-profile', 'nope']).status).toBe(2);
    expect(run(['bogus']).status).toBe(2);
  });

  it('diagnoses the setup with doctor', () => {
    const result = run(['doctor', '--json']);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; level: string }>;
    expect(checks.find((check) => check.name === 'Provider: command')?.level).toBe('ok');
    expect(result.status).toBe(0);
  });

  it('starts as a detached child that outlives the caller', async () => {
    const child = spawn(process.execPath, [BUNDLE, 'speak', 'Detached.'], { env, cwd: root });
    await new Promise((resolve) => child.once('exit', resolve));
    await waitFor(() => spokenTexts().includes('Detached.'));
    expect((await request(paths.brokerEndpoint, { op: 'ping' }))?.ok).toBe(true);
  });
});
