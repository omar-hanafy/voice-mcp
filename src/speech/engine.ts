import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolvePlayback } from '../audio/player.js';
import { CommandError, type ProcessRunner } from '../audio/process-runner.js';
import { expandHome, type AppPaths } from '../config/paths.js';
import type { EffectiveConfig, ProviderId } from '../config/settings.js';
import type { OsFamily } from '../platform.js';
import type { StatusSink } from '../status/status.js';
import { errorMessage } from '../util/errors.js';
import { ensurePrivateDir } from '../util/fs.js';
import type { Logger } from '../util/logger.js';
import { commandProvider } from './providers/command.js';
import { kokoroProvider } from './providers/kokoro.js';
import { piperProvider } from './providers/piper.js';
import { systemProvider } from './providers/system.js';
import { ProviderUnavailableError, type SpeechProvider } from './providers/types.js';
import { previewText } from './text.js';

export const PROVIDERS: Readonly<Record<ProviderId, SpeechProvider>> = {
  kokoro: kokoroProvider,
  piper: piperProvider,
  system: systemProvider,
  command: commandProvider,
};

export type SpeechOutcome =
  | { status: 'spoken'; provider: ProviderId; voice: string }
  | { status: 'stopped' }
  | { status: 'failed'; error: string };

export interface EngineDeps {
  paths: AppPaths;
  runner: ProcessRunner;
  status: StatusSink;
  logger: Logger;
  family: OsFamily;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
  /** Private parent for per-job scratch folders (one per broker). Defaults to paths.tempDir. */
  workRoot?: string;
  providers?: Readonly<Record<ProviderId, SpeechProvider>>;
}

/** The control plane's preferred provider goes first; the rest keep their configured order. */
export function providerOrder(config: EffectiveConfig): ProviderId[] {
  const order = config.settings.providers.order;
  const preferred = config.control.preferredProvider;
  if (!preferred || preferred === 'auto') return [...order];
  return [preferred, ...order.filter((id) => id !== preferred)];
}

function chimeFile(config: EffectiveConfig, paths: AppPaths, logger: Logger): string | null {
  const notification = config.settings.notification;
  if (!notification.enabled) return null;
  const file = notification.path ? path.resolve(expandHome(notification.path)) : paths.defaultChimePath;
  if (fs.existsSync(file)) return file;
  logger.warn('Chime file not found; speaking without it', { path: file });
  return null;
}

/**
 * Speak one message: try each provider in order until one produces speech, play the chime once
 * before the first audio, and clean up every temp file. Never throws.
 */
export async function speak(text: string, config: EffectiveConfig, signal: AbortSignal, deps: EngineDeps): Promise<SpeechOutcome> {
  const providers = deps.providers ?? PROVIDERS;
  const settings = config.settings;
  const preview = previewText(text, 80);
  const failures: string[] = [];
  let chime = chimeFile(config, deps.paths, deps.logger);
  let workDir: string | null = null;

  const play = async (files: string[]) => {
    for (const invocation of resolvePlayback({ files, settings: settings.audio, family: deps.family, find: deps.find })) {
      await deps.runner.run(invocation.command, invocation.args, {
        label: invocation.label,
        timeoutMs: settings.audio.playbackTimeoutMs,
        signal,
        env: invocation.env,
        captureStderr: true,
      });
    }
  };

  /** Play the speech, preceded by the chime once per message. A broken chime never blocks speech. */
  const playWithChime = async (file: string | null) => {
    const files = [...(chime ? [chime] : []), ...(file ? [file] : [])];
    if (files.length === 0) return;
    const usedChime = chime;
    chime = null;
    try {
      await play(files);
    } catch (error) {
      if (signal.aborted || !usedChime || !file) throw error;
      deps.logger.warn('Playback with chime failed; retrying without it', { error: errorMessage(error) });
      await play([file]);
    }
  };

  try {
    const workRoot = deps.workRoot ?? deps.paths.tempDir;
    await ensurePrivateDir(deps.paths.tempDir);
    if (workRoot !== deps.paths.tempDir) await ensurePrivateDir(workRoot);
    workDir = await fsp.mkdtemp(path.join(workRoot, 'job-'));
    if (resolvePlayback({ files: ['probe'], settings: settings.audio, family: deps.family, find: deps.find }).length === 0) {
      throw new Error('No audio player found. Install paplay, aplay, or ffplay, or set audio.player.');
    }

    const order = providerOrder(config);
    for (const [index, id] of order.entries()) {
      if (signal.aborted) return { status: 'stopped' };
      const provider = providers[id];
      // The voice override names a voice of the first-choice provider; applying it to a fallback
      // would pass an unknown voice to a different engine.
      const voiceOverride = index === 0 ? config.control.voiceOverride : null;
      deps.status.setActivity('generating', id, voiceOverride, preview);

      try {
        if (provider.speaksDirectly(settings)) await playWithChime(null);
        const result = await provider.synthesize({
          text,
          voiceOverride,
          settings,
          paths: deps.paths,
          family: deps.family,
          runner: deps.runner,
          signal,
          workDir,
          find: deps.find,
          env: deps.env,
        });
        if (result.kind === 'file') {
          if (!fs.existsSync(result.file)) throw new Error(`${id} did not produce audio`);
          deps.status.setActivity('playing', id, result.voice, preview);
          await playWithChime(result.file);
        }
        deps.status.noteSpoken();
        return { status: 'spoken', provider: id, voice: result.voice };
      } catch (error) {
        if (signal.aborted || (error instanceof CommandError && error.reason === 'aborted')) {
          return { status: 'stopped' };
        }
        if (error instanceof ProviderUnavailableError) {
          deps.logger.debug('Provider unavailable', { provider: id, reason: error.message });
        } else {
          deps.logger.warn('Provider failed', { provider: id, error: errorMessage(error) });
        }
        failures.push(`${id}: ${errorMessage(error)}`);
      }
    }

    const error = failures.length > 0 ? failures.join(' | ') : 'No speech providers are enabled.';
    deps.status.noteError(error);
    return { status: 'failed', error };
  } catch (error) {
    if (signal.aborted) return { status: 'stopped' };
    const message = errorMessage(error);
    deps.status.noteError(message);
    return { status: 'failed', error: message };
  } finally {
    deps.status.setActivity('idle');
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
