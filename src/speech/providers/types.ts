import type { ProcessRunner } from '../../audio/process-runner.js';
import type { AppPaths } from '../../config/paths.js';
import type { ProviderId, Settings } from '../../config/settings.js';
import type { OsFamily } from '../../platform.js';

export interface SynthesisRequest {
  text: string;
  /** Voice chosen by the control plane for this attempt, or null for the provider's setting. */
  voiceOverride: string | null;
  settings: Settings;
  paths: AppPaths;
  family: OsFamily;
  runner: ProcessRunner;
  signal: AbortSignal;
  /** Private scratch directory for this job; removed afterwards. */
  workDir: string;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
}

export type SynthesisResult =
  /** Audio written to a file that the engine plays (after the chime). */
  | { kind: 'file'; file: string; voice: string }
  /** The provider already spoke through the speakers. */
  | { kind: 'spoken'; voice: string };

export interface SpeechProvider {
  readonly id: ProviderId;
  /**
   * Whether this provider speaks by itself instead of producing a file. The engine plays the chime
   * before such providers run.
   */
  speaksDirectly(settings: Settings): boolean;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

/**
 * The provider is not installed or not configured on this machine. The engine moves on to the
 * next provider quietly, since this is an expected state rather than a failure.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
