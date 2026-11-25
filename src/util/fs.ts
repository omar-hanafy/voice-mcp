import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { delay, errorCode, isMissingFile } from './errors.js';

const TEMP_PREFIX = '.tmp-';

/** Codes Windows returns while another process (an editor, antivirus, a reader) holds the target. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 10;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
      await delay(15 * attempt);
    }
  }
}

/**
 * Replace a file atomically: readers see either the old or the new content, never a partial
 * write. The temp file lives beside the target so the rename never crosses a filesystem.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${TEMP_PREFIX}${path.basename(filePath)}-${randomUUID()}`);
  try {
    await fsp.writeFile(tmpPath, data);
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write only when the content differs, so watchers and editors are not disturbed needlessly. */
export async function writeFileIfChanged(filePath: string, data: string): Promise<boolean> {
  try {
    if ((await fsp.readFile(filePath, 'utf8')) === data) return false;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFileAtomic(filePath, data);
  return true;
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove temp files that a killed process left behind. Only files older than `minAgeMs` are
 * touched so a write that is in flight right now is never disturbed.
 */
export async function sweepStaleTempFiles(dir: string, minAgeMs = 60_000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - minAgeMs;
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fsp.rm(full, { force: true });
        removed += 1;
      }
    } catch {
      // Another process may have finished or removed it; that is fine.
    }
  }
  return removed;
}

/**
 * Create a directory only this user can use. On POSIX an existing directory must be owned by
 * the current user and closed to others; anything else (for example a folder another user
 * pre-created in a shared /tmp) is refused rather than trusted.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const stat = await fsp.lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use ${dir}: it must be a directory owned by you with mode 0700`);
  }
}
