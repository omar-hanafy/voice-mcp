import type { Settings } from '../config/settings.js';
import { normalizeSpeakText } from './text.js';

export type GuardrailSettings = Settings['guardrails'];
export type DropReason = 'empty' | 'too-long' | 'cooldown' | 'rate-limit' | 'dedupe' | 'panic-mute';

export type GuardrailDecision = { allowed: true; text: string } | { allowed: false; reason: DropReason };

/**
 * Anti-spam checks applied before a message is queued: length cap, cooldown, duplicate
 * suppression, a token-bucket rate limit, and an optional in-memory "panic mute" fuse that
 * trips when messages are dropped too quickly. Deterministic for a given call sequence.
 */
export class Guardrails {
  private lastAcceptedAt: number | null = null;
  private bucket: { tokens: number; refilledAt: number } | null = null;
  private readonly recent = new Map<string, number>();
  private readonly drops: number[] = [];
  private panicUntil: number | null = null;

  /** Whether the panic-mute fuse is currently engaged. */
  panicMutedUntil(now: number): number | null {
    return this.panicUntil !== null && now < this.panicUntil ? this.panicUntil : null;
  }

  evaluate(raw: string, settings: GuardrailSettings, now: number): GuardrailDecision {
    const text = normalizeSpeakText(raw);
    if (!text) return { allowed: false, reason: 'empty' };
    if (!settings.enabled) return { allowed: true, text };

    const decision = this.check(text, settings, now);
    if (!decision.allowed) {
      this.recordDrop(settings, now);
      return decision;
    }

    this.lastAcceptedAt = now;
    if (settings.dedupeWindowMs > 0) this.recent.set(text, now);
    return decision;
  }

  private check(text: string, settings: GuardrailSettings, now: number): GuardrailDecision {
    if (this.panicMutedUntil(now) !== null) return { allowed: false, reason: 'panic-mute' };
    if (text.length > settings.maxCharsPerMessage) return { allowed: false, reason: 'too-long' };

    if (settings.cooldownMs > 0 && this.lastAcceptedAt !== null) {
      const elapsed = now - this.lastAcceptedAt;
      if (elapsed >= 0 && elapsed < settings.cooldownMs) return { allowed: false, reason: 'cooldown' };
    }

    if (settings.dedupeWindowMs > 0) {
      for (const [key, at] of this.recent) {
        if (now - at >= settings.dedupeWindowMs || now < at) this.recent.delete(key);
      }
      if (this.recent.has(text)) return { allowed: false, reason: 'dedupe' };
    }

    if (settings.maxMessagesPerMinute > 0 && !this.takeToken(settings, now)) {
      return { allowed: false, reason: 'rate-limit' };
    }
    return { allowed: true, text };
  }

  private takeToken(settings: GuardrailSettings, now: number): boolean {
    const capacity = settings.burst;
    if (!this.bucket) {
      this.bucket = { tokens: capacity, refilledAt: now };
    } else {
      const elapsed = Math.max(0, now - this.bucket.refilledAt);
      this.bucket.tokens = Math.min(capacity, this.bucket.tokens + (elapsed * settings.maxMessagesPerMinute) / 60_000);
      this.bucket.refilledAt = now;
    }
    if (this.bucket.tokens < 1) return false;
    this.bucket.tokens -= 1;
    return true;
  }

  private recordDrop(settings: GuardrailSettings, now: number): void {
    const fuse = settings.panicMuteOnDrops;
    if (!fuse || !fuse.enabled) {
      this.drops.length = 0;
      return;
    }
    this.drops.push(now);
    const cutoff = now - fuse.windowMs;
    while (this.drops.length > 0 && this.drops[0]! < cutoff) this.drops.shift();
    if (this.drops.length >= fuse.threshold) {
      this.panicUntil = now + fuse.muteForMs;
      this.drops.length = 0;
    }
  }
}
