import fsp from 'node:fs/promises';

import { errorMessage, isPlainObject } from '../util/errors.js';
import {
  readTextIfExists,
  sweepStaleTempFiles,
  writeFileAtomic,
  writeFileIfChanged,
  writeJsonAtomic,
} from '../util/fs.js';
import { parseJsonc } from './jsonc.js';
import type { AppPaths } from './paths.js';
import { parseControlState, settingsJsonSchema, type ControlState } from './settings.js';
import { SETTINGS_TEMPLATE } from './template.js';

export interface RawSettings {
  /** The parsed document, or null when the file is missing or invalid. */
  value: unknown;
  /** Why the file could not be used, for diagnostics. Null when it parsed (or is absent). */
  error: string | null;
}

/**
 * Make sure the data directory exists with a settings file and an up-to-date schema. Safe to
 * call from every entry point: it only writes what is missing or stale.
 */
export async function ensureDataDir(paths: AppPaths): Promise<void> {
  await fsp.mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  if ((await readTextIfExists(paths.settingsPath)) === null) {
    await writeFileAtomic(paths.settingsPath, SETTINGS_TEMPLATE);
  }
  await writeFileIfChanged(paths.schemaPath, `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`);
}

/** Housekeeping for long-lived processes: clear temp files that killed writers left behind. */
export async function sweepDataDir(paths: AppPaths): Promise<void> {
  await sweepStaleTempFiles(paths.dataDir);
}

export async function readRawSettings(paths: AppPaths): Promise<RawSettings> {
  let text: string | null;
  try {
    text = await readTextIfExists(paths.settingsPath);
  } catch (error) {
    return { value: null, error: `Cannot read ${paths.settingsPath}: ${errorMessage(error)}` };
  }
  if (text === null) return { value: {}, error: null };
  try {
    const value = parseJsonc(text);
    if (!isPlainObject(value)) {
      return { value: null, error: `${paths.settingsPath} must contain a JSON object.` };
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: `Invalid JSONC in ${paths.settingsPath}: ${errorMessage(error)}` };
  }
}

export async function readControlState(paths: AppPaths): Promise<ControlState> {
  try {
    const text = await readTextIfExists(paths.statePath);
    return parseControlState(text === null ? {} : JSON.parse(text));
  } catch {
    // A corrupt state file means "no overrides"; the next write replaces it.
    return parseControlState({});
  }
}

export async function updateControlState(
  paths: AppPaths,
  update: (current: ControlState) => Partial<ControlState>
): Promise<ControlState> {
  const current = await readControlState(paths);
  const next = parseControlState({ ...current, ...update(current) });
  await writeJsonAtomic(paths.statePath, next);
  return next;
}
