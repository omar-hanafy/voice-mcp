import fsp from 'node:fs/promises';
import path from 'node:path';

import { expandHome } from '../../config/paths.js';
import type { Settings } from '../../config/settings.js';
import { ProviderUnavailableError, type SpeechProvider, type SynthesisRequest } from './types.js';

const OUT_FILE_TOKEN = '{outFile}';

export function writesOutputFile(args: readonly string[]): boolean {
  return args.some((arg) => arg.includes(OUT_FILE_TOKEN));
}

export function expandCommandArgs(
  args: readonly string[],
  values: { text: string; textFile: string; outFile: string; voice: string }
): string[] {
  return args.map((arg) =>
    arg
      .replaceAll('{textFile}', values.textFile)
      .replaceAll(OUT_FILE_TOKEN, values.outFile)
      .replaceAll('{voice}', values.voice)
      .replaceAll('{text}', values.text)
  );
}

/** Bring-your-own TTS: any executable that either writes an audio file or speaks by itself. */
export const commandProvider: SpeechProvider = {
  id: 'command',
  speaksDirectly: (settings: Settings) => !writesOutputFile(settings.providers.command.args),
  async synthesize(request: SynthesisRequest) {
    const settings = request.settings.providers.command;
    if (!settings.command) throw new ProviderUnavailableError('command provider is not configured');

    const textFile = path.join(request.workDir, 'command.txt');
    const outFile = path.join(request.workDir, 'command.wav');
    await fsp.writeFile(textFile, request.text, 'utf8');
    const voice = request.voiceOverride ?? '';
    const args = expandCommandArgs(settings.args, { text: request.text, textFile, outFile, voice });

    await request.runner.run(expandHome(settings.command), args, {
      label: path.basename(settings.command),
      timeoutMs: request.settings.audio.generationTimeoutMs,
      signal: request.signal,
      captureStderr: true,
    });

    const label = voice || path.basename(settings.command);
    return writesOutputFile(settings.args)
      ? { kind: 'file', file: outFile, voice: label }
      : { kind: 'spoken', voice: label };
  },
};
