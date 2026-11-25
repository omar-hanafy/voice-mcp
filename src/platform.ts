import fs from 'node:fs';
import path from 'node:path';

export type OsFamily = 'macos' | 'windows' | 'linux';

export function osFamily(platform: NodeJS.Platform = process.platform): OsFamily {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

export const OS_LABEL: Record<OsFamily, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

export interface WhichOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function isExecutableFile(candidate: string, windows: boolean): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (windows) return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Without a shell, Windows can only start .exe and .com files; Node refuses .cmd and .bat. */
const WINDOWS_SPAWNABLE = ['.exe', '.com'];

function candidateNames(command: string, windows: boolean): string[] {
  if (!windows) return [command];
  const ext = path.extname(command).toLowerCase();
  if (WINDOWS_SPAWNABLE.includes(ext)) return [command];
  // "python3.11" has a dot but no real extension, so still try appending one.
  return WINDOWS_SPAWNABLE.map((suffix) => command + suffix);
}

/**
 * Resolve a command the way spawning it without a shell would. Returns the absolute path, or
 * null when nothing on PATH matches. On Windows only .exe and .com files count, because a
 * `.cmd`/`.bat` shim or an extensionless script (pyenv-win, npm) cannot be started directly.
 */
export function which(command: string, options: WhichOptions = {}): string | null {
  const env = options.env ?? process.env;
  const windows = osFamily(options.platform) === 'windows';
  const trimmed = command.trim();
  if (!trimmed) return null;
  const names = candidateNames(trimmed, windows);

  const hasDir = trimmed.includes('/') || (windows && trimmed.includes('\\'));
  if (hasDir) {
    for (const name of names) {
      const candidate = path.resolve(name);
      if (isExecutableFile(candidate, windows)) return candidate;
    }
    return null;
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const separator = windows ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, '$1'), name);
      if (isExecutableFile(candidate, windows)) return candidate;
    }
  }
  return null;
}
