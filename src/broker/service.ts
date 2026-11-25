import type { ConfigStore } from '../config/store.js';
import { publishToNtfy } from '../notify/ntfy.js';
import { speak, type EngineDeps } from '../speech/engine.js';
import { Guardrails } from '../speech/guardrails.js';
import { SpeechQueue } from '../speech/queue.js';
import type { StatusReporter } from '../status/status.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

/**
 * The broker's speech pipeline: fresh config -> guardrails -> ntfy mirror -> mute gate ->
 * queue -> engine. Requests are processed one at a time in arrival order so guardrail state
 * (cooldown, dedupe, rate limit) is deterministic.
 */
export class SpeechService {
  readonly queue: SpeechQueue;
  private readonly guardrails = new Guardrails();
  private chain: Promise<void> = Promise.resolve();
  private pendingSubmits = 0;

  constructor(
    private readonly config: ConfigStore,
    private readonly status: StatusReporter,
    private readonly engine: EngineDeps,
    private readonly logger: Logger,
    private readonly fetchImpl?: typeof fetch
  ) {
    this.queue = new SpeechQueue(
      () => this.config.get().settings.queue,
      (depth) => this.status.setQueueDepth(depth),
      (error) => this.logger.error('Speech job crashed', { error: errorMessage(error) })
    );
  }

  isIdle(): boolean {
    return this.pendingSubmits === 0 && this.queue.isIdle();
  }

  submit(text: string, mirrorNtfy: boolean): Promise<void> {
    this.pendingSubmits += 1;
    const run = this.chain.then(() => this.process(text, mirrorNtfy));
    this.chain = run
      .catch((error) => this.logger.error('Speak request failed', { error: errorMessage(error) }))
      .finally(() => {
        this.pendingSubmits -= 1;
      });
    return this.chain;
  }

  stopAll(reason: 'stopped' | 'muted'): number {
    const affected = this.queue.stopAll(reason);
    this.engine.runner.stopActive(reason);
    this.status.setActivity('idle');
    return affected;
  }

  private async process(text: string, mirrorNtfy: boolean): Promise<void> {
    // Read the control state from disk so an unmute or voice switch applies to this very line,
    // even if the file watcher has not fired yet.
    await this.config.reload();
    const config = this.config.get();
    this.status.count('requests');
    this.status.setSettingsError(this.config.settingsError);

    const decision = this.guardrails.evaluate(text, config.settings.guardrails, Date.now());
    if (!decision.allowed) {
      this.status.count('droppedGuardrails');
      this.logger.debug('Message dropped by guardrails', { reason: decision.reason });
      return;
    }

    // The mirror fires for every accepted line, muted or not (the tag shows which), so a phone
    // still gets the update while the speakers are quiet.
    if (mirrorNtfy) {
      void publishToNtfy({
        settings: config.settings.ntfy,
        text: decision.text,
        muted: config.muted,
        logger: this.logger,
        fetchImpl: this.fetchImpl,
      });
    }

    if (config.muted) {
      this.status.count('droppedMuted');
      return;
    }

    const result = this.queue.enqueue(async (signal) => {
      const outcome = await speak(decision.text, this.config.get(), signal, this.engine);
      if (outcome.status === 'failed') this.logger.warn('Could not speak', { error: outcome.error });
      else this.logger.debug('Speech finished', { outcome });
    });
    if (!result.accepted) this.status.count('droppedQueue');
    for (let i = 0; i < result.dropped; i += 1) this.status.count('droppedQueue');
  }
}
