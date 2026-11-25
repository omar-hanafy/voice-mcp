/**
 * Renders real speech with the OS voice into a file (nothing is played, so it is silent):
 * `say` on macOS, SAPI through Windows PowerShell on Windows, espeak-ng on Linux. Skips when
 * the platform voice is not installed (for example Linux without espeak-ng).
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProcessRunner } from '../src/audio/process-runner.js';
import type { AppPaths } from '../src/config/paths.js';
import { parseSettings } from '../src/config/settings.js';
import { osFamily, which } from '../src/platform.js';
import { checkProvider } from '../src/speech/availability.js';
import { systemProvider } from '../src/speech/providers/system.js';
import { silentLogger } from '../src/util/logger.js';
import { tempPaths } from './helpers.js';

const family = osFamily();
const find = (command: string) => which(command);
const settings = parseSettings({});

let paths: AppPaths;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ paths, cleanup } = await tempPaths());
});
afterEach(async () => {
  await cleanup();
});

const available = checkProvider({ id: 'system', settings, paths: {} as AppPaths, family, find, env: process.env }).available;

describe.skipIf(!available)(`system voice on ${family}`, () => {
  it('renders a non-empty audio file', async () => {
    fs.mkdirSync(paths.tempDir, { recursive: true });
    const result = await systemProvider.synthesize({
      text: '-v This line starts with a dash and must be spoken, not parsed.',
      voiceOverride: null,
      settings,
      paths,
      family,
      runner: new ProcessRunner(silentLogger, () => 500),
      signal: new AbortController().signal,
      workDir: paths.tempDir,
      find,
      env: process.env,
    });
    expect(result.kind).toBe('file');
    if (result.kind === 'file') expect(fs.statSync(result.file).size).toBeGreaterThan(1_000);
  }, 60_000);
});
