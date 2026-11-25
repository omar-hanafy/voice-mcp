import { which } from '../platform.js';
import type { OsFamily } from '../platform.js';

export interface PlayerInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
}

export const WINDOWS_POWERSHELL = 'powershell.exe';

/** Common flags for a quiet, non-interactive Windows PowerShell child. */
export function powershellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

/** `|` cannot appear in a Windows path, so it safely separates a list of files. */
export const WINDOWS_FILE_SEPARATOR = '|';

/**
 * Windows has no built-in command-line player, but every install ships Windows PowerShell with
 * System.Media.SoundPlayer. Paths travel in an environment variable, so no path can break the
 * script's quoting, and several files play in one PowerShell start (PowerShell is slow to start).
 * SoundPlayer plays PCM WAV, which every bundled provider and the chime produce.
 */
export const WINDOWS_PLAY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "foreach ($f in ($env:VOICE_MCP_AUDIO_FILES -split '\\|')) { if ($f) { $p = New-Object System.Media.SoundPlayer $f; $p.PlaySync(); $p.Dispose() } }",
].join('; ');

const LINUX_PLAYERS: ReadonlyArray<{ command: string; args: (file: string) => string[] }> = [
  { command: 'paplay', args: (file) => [file] },
  { command: 'pw-play', args: (file) => [file] },
  { command: 'aplay', args: (file) => ['-q', file] },
  { command: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
];

export interface PlayerSettings {
  player: string | null;
  playerArgs: string[];
}

/**
 * Build the commands that play `files` in order. Returns an empty list when no player is
 * available (Linux without any supported player installed).
 */
export function resolvePlayback(params: {
  files: readonly string[];
  settings: PlayerSettings;
  family: OsFamily;
  find?: (command: string) => string | null;
}): PlayerInvocation[] {
  const { files, settings, family } = params;
  const find = params.find ?? ((command: string) => which(command));
  if (files.length === 0) return [];

  if (settings.player) {
    const player = settings.player;
    return files.map((file) => ({ command: player, args: [...settings.playerArgs, file], label: player }));
  }

  switch (family) {
    case 'macos':
      return files.map((file) => ({ command: 'afplay', args: [...settings.playerArgs, file], label: 'afplay' }));
    case 'windows':
      return [
        {
          command: WINDOWS_POWERSHELL,
          args: powershellArgs(WINDOWS_PLAY_SCRIPT),
          env: { VOICE_MCP_AUDIO_FILES: files.join(WINDOWS_FILE_SEPARATOR) },
          label: 'SoundPlayer',
        },
      ];
    case 'linux': {
      const candidate = LINUX_PLAYERS.find((player) => find(player.command));
      if (!candidate) return [];
      return files.map((file) => ({
        command: candidate.command,
        args: [...settings.playerArgs, ...candidate.args(file)],
        label: candidate.command,
      }));
    }
  }
}

export function describeDefaultPlayer(family: OsFamily): string {
  switch (family) {
    case 'macos':
      return 'afplay';
    case 'windows':
      return 'PowerShell System.Media.SoundPlayer';
    case 'linux':
      return LINUX_PLAYERS.map((player) => player.command).join(', ');
  }
}

export function findDefaultPlayer(family: OsFamily, find: (command: string) => string | null): string | null {
  switch (family) {
    case 'macos':
      return find('afplay');
    case 'windows':
      return find(WINDOWS_POWERSHELL);
    case 'linux':
      for (const player of LINUX_PLAYERS) {
        const found = find(player.command);
        if (found) return found;
      }
      return null;
  }
}
