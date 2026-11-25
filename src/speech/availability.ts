import fs from 'node:fs';
import path from 'node:path';

import { WINDOWS_POWERSHELL } from '../audio/player.js';
import { expandHome, type AppPaths } from '../config/paths.js';
import type { ProviderId, Settings } from '../config/settings.js';
import type { OsFamily } from '../platform.js';
import { resolveKokoroFiles } from './providers/kokoro.js';
import { defaultPython, resolvePiperDataDir } from './providers/piper.js';

export interface Availability {
  available: boolean;
  detail: string;
  hint?: string;
}

/**
 * Static readiness check for a provider: are its executable and model files where the settings
 * say? It does not synthesize anything, so it is fast and silent.
 */
export function checkProvider(params: {
  id: ProviderId;
  settings: Settings;
  paths: AppPaths;
  family: OsFamily;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
}): Availability {
  const { id, settings, family, find } = params;
  switch (id) {
    case 'system': {
      if (family === 'macos') {
        return find('say')
          ? { available: true, detail: 'macOS say' }
          : { available: false, detail: '`say` not found' };
      }
      if (family === 'windows') {
        return find(WINDOWS_POWERSHELL)
          ? { available: true, detail: 'Windows SAPI via PowerShell' }
          : { available: false, detail: 'powershell.exe not found' };
      }
      const espeak = find('espeak-ng') ?? find('espeak');
      return espeak
        ? { available: true, detail: path.basename(espeak) }
        : { available: false, detail: 'espeak-ng not found', hint: 'Install espeak-ng with your package manager.' };
    }
    case 'kokoro': {
      const kokoro = settings.providers.kokoro;
      const cli = find(kokoro.cli);
      if (!cli) {
        return {
          available: false,
          detail: `${kokoro.cli} not found`,
          hint: 'pip install kokoro-tts (Python 3.10-3.12), then: voice-mcp models install kokoro',
        };
      }
      const files = resolveKokoroFiles(params);
      const missing = [files.modelPath, files.voicesPath].filter((file) => !fs.existsSync(file));
      if (missing.length > 0) {
        return {
          available: false,
          detail: `model missing: ${missing.join(', ')}`,
          hint: 'voice-mcp models install kokoro',
        };
      }
      return { available: true, detail: `${kokoro.voice} via ${cli}` };
    }
    case 'piper': {
      const piper = settings.providers.piper;
      const pythonName = piper.python ?? defaultPython(family);
      const python = find(pythonName);
      if (!python) {
        return { available: false, detail: `${pythonName} not found`, hint: 'pip install piper-tts' };
      }
      const dataDir = resolvePiperDataDir(params);
      const modelFile = piper.model.endsWith('.onnx') ? path.resolve(dataDir, piper.model) : path.join(dataDir, `${piper.model}.onnx`);
      if (!fs.existsSync(modelFile)) {
        return {
          available: false,
          detail: `voice ${piper.model} not in ${dataDir}`,
          hint: `voice-mcp models install piper ${piper.model}`,
        };
      }
      return { available: true, detail: `${piper.model} via ${pythonName} (piper-tts install not verified)` };
    }
    case 'command': {
      const command = settings.providers.command.command;
      if (!command) return { available: false, detail: 'not configured' };
      return find(expandHome(command))
        ? { available: true, detail: command }
        : { available: false, detail: `${command} not found` };
    }
  }
}
