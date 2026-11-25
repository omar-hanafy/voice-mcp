import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths, type AppPaths } from '../src/config/paths.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE = path.join(REPO_ROOT, 'plugin', 'dist', 'voice-mcp.mjs');

/** A fresh data directory for one test, cleaned up by the returned function. */
export async function tempPaths(): Promise<{ paths: AppPaths; root: string; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vmcp-test-'));
  const paths = resolvePaths({ env: { VOICE_MCP_HOME: path.join(root, 'home') }, tempDir: root });
  return {
    paths,
    root,
    cleanup: async () => {
      // Sweep twice: an in-process broker can finish one last debounced write while tearing down.
      for (let pass = 0; pass < 2; pass += 1) {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (pass === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
  };
}

/**
 * Writes a tiny Node script that stands in for an audio player or TTS engine. It appends its
 * arguments (and selected environment variables) as one JSON line to `logFile`, optionally
 * copies an input file to an output path, and can sleep to simulate long playback.
 */
export function writeFakeTool(dir: string, name: string, logFile: string): string {
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ tool: ${JSON.stringify(name)}, args }) + '\\n');
const out = args.indexOf('--out');
const delay = args.indexOf('--delay');
const write = () => {
  if (out >= 0) fs.writeFileSync(args[out + 1], 'RIFF-fake-audio');
};
if (delay >= 0) setTimeout(write, Number(args[delay + 1]));
else write();
const sleep = args.indexOf('--sleep');
if (sleep >= 0) setTimeout(() => {}, Number(args[sleep + 1]));
`
  );
  return script;
}

export async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}

export function readJsonLines(file: string): Array<{ tool: string; args: string[] }> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; args: string[] });
}
