import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { expandHome, resolveModelsDir } from '../../config/paths.js';
import type { AppPaths } from '../../config/paths.js';
import type { Settings } from '../../config/settings.js';
import { ProviderUnavailableError, type SpeechProvider, type SynthesisRequest } from './types.js';

export const KOKORO_MODEL_FILE = 'kokoro-v1.0.onnx';
export const KOKORO_VOICES_FILE = 'voices-v1.0.bin';

export function resolveKokoroFiles(params: {
  settings: Settings;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
}): { modelPath: string; voicesPath: string } {
  const { settings, paths, env } = params;
  const kokoro = settings.providers.kokoro;
  const modelsDir = resolveModelsDir({ paths, configured: settings.modelsDir, env });
  const pick = (configured: string | null, envValue: string | undefined, file: string) => {
    const explicit = configured ?? (envValue?.trim() ? envValue.trim() : null);
    return explicit ? path.resolve(expandHome(explicit)) : path.join(modelsDir, 'kokoro', file);
  };
  return {
    modelPath: pick(kokoro.modelPath, env.KOKORO_MODEL_PATH, KOKORO_MODEL_FILE),
    voicesPath: pick(kokoro.voicesPath, env.KOKORO_VOICES_PATH, KOKORO_VOICES_FILE),
  };
}

export function buildKokoroArgs(params: {
  textFile: string;
  outFile: string;
  modelPath: string;
  voicesPath: string;
  voice: string;
  lang: string;
  speed: number;
}): string[] {
  return [
    params.textFile,
    params.outFile,
    '--format',
    'wav',
    '--lang',
    params.lang,
    '--voice',
    params.voice,
    '--model',
    params.modelPath,
    '--voices',
    params.voicesPath,
    '--speed',
    params.speed.toFixed(2),
  ];
}

export const kokoroProvider: SpeechProvider = {
  id: 'kokoro',
  speaksDirectly: () => false,
  async synthesize(request: SynthesisRequest) {
    const settings = request.settings.providers.kokoro;
    const cli = request.find(settings.cli);
    if (!cli) {
      throw new ProviderUnavailableError(`Kokoro CLI not found (${settings.cli}); install with: pip install kokoro-tts`);
    }
    const { modelPath, voicesPath } = resolveKokoroFiles({
      settings: request.settings,
      paths: request.paths,
      env: request.env,
    });
    for (const file of [modelPath, voicesPath]) {
      if (!fs.existsSync(file)) {
        throw new ProviderUnavailableError(`Kokoro model file missing: ${file}; run: voice-mcp models install kokoro`);
      }
    }

    const voice = request.voiceOverride ?? settings.voice;
    const textFile = path.join(request.workDir, 'kokoro.txt');
    const outFile = path.join(request.workDir, 'kokoro.wav');
    await fsp.writeFile(textFile, request.text, 'utf8');

    await request.runner.run(
      cli,
      buildKokoroArgs({ textFile, outFile, modelPath, voicesPath, voice, lang: settings.lang, speed: settings.speed }),
      {
        label: 'kokoro-tts',
        timeoutMs: request.settings.audio.generationTimeoutMs,
        signal: request.signal,
        cwd: request.workDir,
        captureStderr: true,
      }
    );
    return { kind: 'file', file: outFile, voice: `${voice} (${settings.lang})` };
  },
};
