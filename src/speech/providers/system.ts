import fsp from 'node:fs/promises';
import path from 'node:path';

import { powershellArgs, WINDOWS_POWERSHELL } from '../../audio/player.js';
import type { OsFamily } from '../../platform.js';
import { ProviderUnavailableError, type SpeechProvider, type SynthesisRequest } from './types.js';

export interface SystemInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  outFile: string;
}

/** SAPI rates run from -10 to 10, with 0 at roughly 175 words per minute. */
export function wpmToSapiRate(wpm: number): number {
  return Math.max(-10, Math.min(10, Math.round((wpm - 175) / 18)));
}

/**
 * Renders speech to a WAV file with Windows' built-in System.Speech. Inputs travel through
 * environment variables so no text or path can break the script's quoting.
 */
export const SAPI_TO_WAV_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:VOICE_MCP_VOICE) { $s.SelectVoice($env:VOICE_MCP_VOICE) }',
  'if ($env:VOICE_MCP_RATE) { $s.Rate = [int]$env:VOICE_MCP_RATE }',
  '$t = [System.IO.File]::ReadAllText($env:VOICE_MCP_TEXT_FILE, [System.Text.Encoding]::UTF8)',
  '$s.SetOutputToWaveFile($env:VOICE_MCP_OUT_FILE)',
  '$s.Speak($t)',
  '$s.Dispose()',
].join('; ');

export const SAPI_LIST_VOICES_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }',
].join('; ');

export function buildSystemInvocation(params: {
  family: OsFamily;
  textFile: string;
  workDir: string;
  voice: string | null;
  rate: number | null;
  find: (command: string) => string | null;
}): SystemInvocation {
  const { family, textFile, workDir, voice, rate } = params;
  switch (family) {
    case 'macos': {
      const outFile = path.join(workDir, 'system.aiff');
      const args = ['-f', textFile, '-o', outFile];
      if (voice) args.push('-v', voice);
      if (rate !== null) args.push('-r', String(rate));
      return { command: 'say', args, outFile };
    }
    case 'windows': {
      const outFile = path.join(workDir, 'system.wav');
      const env: NodeJS.ProcessEnv = { VOICE_MCP_TEXT_FILE: textFile, VOICE_MCP_OUT_FILE: outFile };
      if (voice) env.VOICE_MCP_VOICE = voice;
      if (rate !== null) env.VOICE_MCP_RATE = String(wpmToSapiRate(rate));
      return { command: WINDOWS_POWERSHELL, args: powershellArgs(SAPI_TO_WAV_SCRIPT), env, outFile };
    }
    case 'linux': {
      const command = params.find('espeak-ng') ? 'espeak-ng' : params.find('espeak') ? 'espeak' : null;
      if (!command) {
        throw new ProviderUnavailableError('system voice needs espeak-ng (or espeak) on Linux');
      }
      const outFile = path.join(workDir, 'system.wav');
      const args = ['-f', textFile, '-w', outFile];
      if (voice) args.push('-v', voice);
      if (rate !== null) args.push('-s', String(rate));
      return { command, args, outFile };
    }
  }
}

export const systemProvider: SpeechProvider = {
  id: 'system',
  speaksDirectly: () => false,
  async synthesize(request: SynthesisRequest) {
    const settings = request.settings.providers.system;
    const voice = request.voiceOverride ?? settings.voice;
    const textFile = path.join(request.workDir, 'system.txt');
    // Reading the text from a file means a message starting with "-" can never become a flag.
    await fsp.writeFile(textFile, request.text, 'utf8');

    const invocation = buildSystemInvocation({
      family: request.family,
      textFile,
      workDir: request.workDir,
      voice,
      rate: settings.rate,
      find: request.find,
    });

    await request.runner.run(invocation.command, invocation.args, {
      label: 'system voice',
      timeoutMs: request.settings.audio.generationTimeoutMs,
      signal: request.signal,
      env: invocation.env,
      captureStderr: true,
    });
    return { kind: 'file', file: invocation.outFile, voice: voice ?? 'system default' };
  },
};
