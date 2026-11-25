import fs from 'node:fs';
import path from 'node:path';

import { expandHome, resolveModelsDir } from '../../config/paths.js';
import type { AppPaths } from '../../config/paths.js';
import type { Settings } from '../../config/settings.js';
import type { OsFamily } from '../../platform.js';
import { ProviderUnavailableError, type SpeechProvider, type SynthesisRequest } from './types.js';

export function defaultPython(family: OsFamily): string {
  return family === 'windows' ? 'python' : 'python3';
}

export function resolvePiperDataDir(params: {
  settings: Settings;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
}): string {
  const { settings, paths, env } = params;
  const configured = settings.providers.piper.dataDir ?? (env.PIPER_DATA_DIR?.trim() || null);
  if (configured) return path.resolve(expandHome(configured));
  return path.join(resolveModelsDir({ paths, configured: settings.modelsDir, env }), 'piper');
}

export function buildPiperArgs(params: { dataDir: string; model: string; outFile: string; text: string }): string[] {
  // `--` ends option parsing, so text that starts with "-" is still spoken as text.
  return ['-m', 'piper', '--data-dir', params.dataDir, '-m', params.model, '-f', params.outFile, '--', params.text];
}

function modelExists(dataDir: string, model: string): boolean {
  if (model.endsWith('.onnx')) return fs.existsSync(path.resolve(dataDir, expandHome(model)));
  return fs.existsSync(path.join(dataDir, `${model}.onnx`));
}

export const piperProvider: SpeechProvider = {
  id: 'piper',
  speaksDirectly: () => false,
  async synthesize(request: SynthesisRequest) {
    const settings = request.settings.providers.piper;
    const pythonName = settings.python ?? defaultPython(request.family);
    const python = request.find(pythonName);
    if (!python) throw new ProviderUnavailableError(`Python not found for Piper (${pythonName})`);

    const dataDir = resolvePiperDataDir({ settings: request.settings, paths: request.paths, env: request.env });
    const model = request.voiceOverride ?? settings.model;
    if (!modelExists(dataDir, model)) {
      throw new ProviderUnavailableError(
        `Piper voice ${model} not found in ${dataDir}; run: voice-mcp models install piper ${model}`
      );
    }

    const outFile = path.join(request.workDir, 'piper.wav');
    await request.runner.run(python, buildPiperArgs({ dataDir, model, outFile, text: request.text }), {
      label: 'piper',
      timeoutMs: request.settings.audio.generationTimeoutMs,
      signal: request.signal,
      captureStderr: true,
    });
    return { kind: 'file', file: outFile, voice: model };
  },
};
