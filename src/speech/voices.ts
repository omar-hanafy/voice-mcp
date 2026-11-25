import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

import { powershellArgs, WINDOWS_POWERSHELL } from '../audio/player.js';
import type { AppPaths } from '../config/paths.js';
import type { ProviderId, Settings } from '../config/settings.js';
import type { OsFamily } from '../platform.js';
import { resolvePiperDataDir } from './providers/piper.js';
import { SAPI_LIST_VOICES_SCRIPT } from './providers/system.js';

const execFileAsync = promisify(execFile);

export interface Voice {
  id: string;
  label: string;
  group: string;
}

/** Voices shipped in Kokoro's voices-v1.0.bin, grouped by language for menus. */
export const KOKORO_VOICES: readonly Voice[] = [
  ...[
    ['af_heart', 'Heart'], ['af_alloy', 'Alloy'], ['af_aoede', 'Aoede'], ['af_bella', 'Bella'],
    ['af_jessica', 'Jessica'], ['af_kore', 'Kore'], ['af_nicole', 'Nicole'], ['af_nova', 'Nova'],
    ['af_river', 'River'], ['af_sarah', 'Sarah'], ['af_sky', 'Sky'],
  ].map(([id, label]) => ({ id: id!, label: label!, group: 'American English (female)' })),
  ...[
    ['am_adam', 'Adam'], ['am_echo', 'Echo'], ['am_eric', 'Eric'], ['am_fenrir', 'Fenrir'],
    ['am_liam', 'Liam'], ['am_michael', 'Michael'], ['am_onyx', 'Onyx'], ['am_puck', 'Puck'],
    ['am_santa', 'Santa'],
  ].map(([id, label]) => ({ id: id!, label: label!, group: 'American English (male)' })),
  ...[['bf_alice', 'Alice'], ['bf_emma', 'Emma'], ['bf_isabella', 'Isabella'], ['bf_lily', 'Lily']].map(
    ([id, label]) => ({ id: id!, label: label!, group: 'British English (female)' })
  ),
  ...[['bm_daniel', 'Daniel'], ['bm_fable', 'Fable'], ['bm_george', 'George'], ['bm_lewis', 'Lewis']].map(
    ([id, label]) => ({ id: id!, label: label!, group: 'British English (male)' })
  ),
  ...[
    ['jf_alpha', 'Alpha (F)'], ['jf_gongitsune', 'Gongitsune (F)'], ['jf_nezumi', 'Nezumi (F)'],
    ['jf_tebukuro', 'Tebukuro (F)'], ['jm_kumo', 'Kumo (M)'],
  ].map(([id, label]) => ({ id: id!, label: label!, group: 'Japanese' })),
  ...[
    ['zf_xiaobei', 'Xiaobei (F)'], ['zf_xiaoni', 'Xiaoni (F)'], ['zf_xiaoxiao', 'Xiaoxiao (F)'],
    ['zf_xiaoyi', 'Xiaoyi (F)'], ['zm_yunjian', 'Yunjian (M)'], ['zm_yunxi', 'Yunxi (M)'],
    ['zm_yunxia', 'Yunxia (M)'], ['zm_yunyang', 'Yunyang (M)'],
  ].map(([id, label]) => ({ id: id!, label: label!, group: 'Mandarin Chinese' })),
  ...[['ef_dora', 'Dora (F)'], ['em_alex', 'Alex (M)'], ['em_santa', 'Santa (M)']].map(([id, label]) => ({
    id: id!,
    label: label!,
    group: 'Spanish',
  })),
  { id: 'ff_siwis', label: 'Siwis (F)', group: 'French' },
  ...[['hf_alpha', 'Alpha (F)'], ['hf_beta', 'Beta (F)'], ['hm_omega', 'Omega (M)'], ['hm_psi', 'Psi (M)']].map(
    ([id, label]) => ({ id: id!, label: label!, group: 'Hindi' })
  ),
  ...[['if_sara', 'Sara (F)'], ['im_nicola', 'Nicola (M)']].map(([id, label]) => ({
    id: id!,
    label: label!,
    group: 'Italian',
  })),
  ...[['pf_dora', 'Dora (F)'], ['pm_alex', 'Alex (M)'], ['pm_santa', 'Santa (M)']].map(([id, label]) => ({
    id: id!,
    label: label!,
    group: 'Brazilian Portuguese',
  })),
];

/** Parse `say -v '?'` output: "Name   locale   # sample sentence". Names may contain spaces. */
export function parseSayVoices(output: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (match) voices.push({ id: match[1]!.trim(), label: match[1]!.trim(), group: match[2]! });
  }
  return voices;
}

/** Parse `espeak-ng --voices`: a header row, then "Pty Language Age/Gender VoiceName File ...". */
export function parseEspeakVoices(output: string): Voice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4)
    .map((cols) => ({ id: cols[1]!, label: cols[3]!.replace(/_/g, ' '), group: cols[1]!.split('-')[0]! }));
}

async function listSystemVoices(family: OsFamily, find: (command: string) => string | null): Promise<Voice[]> {
  switch (family) {
    case 'macos': {
      const { stdout } = await execFileAsync('say', ['-v', '?'], { timeout: 10_000 });
      return parseSayVoices(stdout);
    }
    case 'windows': {
      const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, powershellArgs(SAPI_LIST_VOICES_SCRIPT), {
        timeout: 20_000,
        windowsHide: true,
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => ({ id: name, label: name, group: 'Windows' }));
    }
    case 'linux': {
      const command = find('espeak-ng') ? 'espeak-ng' : find('espeak') ? 'espeak' : null;
      if (!command) return [];
      const { stdout } = await execFileAsync(command, ['--voices'], { timeout: 10_000 });
      return parseEspeakVoices(stdout);
    }
  }
}

async function listPiperVoices(dataDir: string): Promise<Voice[]> {
  try {
    const entries = await fsp.readdir(dataDir);
    return entries
      .filter((name) => name.endsWith('.onnx'))
      .map((name) => name.slice(0, -'.onnx'.length))
      .sort()
      .map((id) => ({ id, label: id, group: 'Installed' }));
  } catch {
    return [];
  }
}

export async function listVoices(params: {
  provider: ProviderId;
  settings: Settings;
  paths: AppPaths;
  family: OsFamily;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
}): Promise<Voice[]> {
  switch (params.provider) {
    case 'kokoro':
      return [...KOKORO_VOICES];
    case 'piper':
      return listPiperVoices(resolvePiperDataDir(params));
    case 'system':
      return listSystemVoices(params.family, params.find).catch(() => []);
    case 'command':
      return [];
  }
}
