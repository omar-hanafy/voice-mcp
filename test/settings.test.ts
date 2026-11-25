import { describe, expect, it } from 'vitest';

import { parseJsonc, stripJsonc } from '../src/config/jsonc.js';
import {
  buildEffectiveConfig,
  parseControlState,
  parseSettings,
  settingsJsonSchema,
  settingsSpec,
} from '../src/config/settings.js';
import { SETTINGS_TEMPLATE } from '../src/config/template.js';

describe('settings parsing', () => {
  it('uses defaults for an empty document', () => {
    const settings = parseSettings({});
    expect(settings.providers.order).toEqual(['kokoro', 'piper', 'system']);
    expect(settings.audio.player).toBeNull();
    expect(settings.guardrails.maxCharsPerMessage).toBe(400);
    expect(settings.ntfy.enabled).toBe(false);
  });

  it('keeps the template and the built-in defaults identical', () => {
    // Deleting a line from the template must never change behavior.
    const fromTemplate = parseSettings(parseJsonc(SETTINGS_TEMPLATE));
    expect(fromTemplate).toEqual(settingsSpec.defaultValue);
  });

  it('falls back per field on wrong types and clamps out-of-range numbers', () => {
    const settings = parseSettings({
      queue: { maxDepth: 9_999, dropPolicy: 'sideways' },
      guardrails: { cooldownMs: -5, burst: 'lots' },
      providers: { kokoro: { speed: 7 } },
      logging: 'loud',
    });
    expect(settings.queue.maxDepth).toBe(250);
    expect(settings.queue.dropPolicy).toBe('oldest');
    expect(settings.guardrails.cooldownMs).toBe(0);
    expect(settings.guardrails.burst).toBe(3);
    expect(settings.providers.kokoro.speed).toBe(2);
    expect(settings.logging.level).toBe('info');
  });

  it('maps the pre-0.5 "say" provider onto "system"', () => {
    const settings = parseSettings({
      providers: { order: ['say', 'kokoro', 'say'], say: { voice: 'Samantha', rate: 190 } },
    });
    expect(settings.providers.order).toEqual(['system', 'kokoro']);
    expect(settings.providers.system).toEqual({ voice: 'Samantha', rate: 190 });
  });

  it('prefers an explicit "system" block over the legacy "say" block', () => {
    const settings = parseSettings({ providers: { say: { voice: 'Old' }, system: { voice: 'New' } } });
    expect(settings.providers.system.voice).toBe('New');
  });

  it('ignores unknown providers and never returns an empty order', () => {
    expect(parseSettings({ providers: { order: ['nope'] } }).providers.order).toEqual(['kokoro', 'piper', 'system']);
  });

  it('treats panicMuteOnDrops: null as disabled', () => {
    expect(parseSettings({ guardrails: { panicMuteOnDrops: null } }).guardrails.panicMuteOnDrops).toBeNull();
  });
});

describe('profiles and effective config', () => {
  const raw = {
    notification: { enabled: true },
    audio: { playerArgs: ['-v', '1'] },
    profiles: {
      meeting: { notification: { enabled: false }, audio: { playerArgs: ['-v', '0.3'] } },
      broken: 'not an object',
    },
  };

  it('deep-merges the selected profile over the base settings', () => {
    const config = buildEffectiveConfig(raw, parseControlState({ profileId: 'meeting' }), 0);
    expect(config.activeProfile).toBe('meeting');
    expect(config.settings.notification.enabled).toBe(false);
    expect(config.settings.audio.playerArgs).toEqual(['-v', '0.3']);
    expect(config.profiles).toEqual(['meeting']);
  });

  it('ignores an unknown profile id', () => {
    const config = buildEffectiveConfig(raw, parseControlState({ profileId: 'gone' }), 0);
    expect(config.activeProfile).toBeNull();
    expect(config.settings.notification.enabled).toBe(true);
  });

  it('derives mute from the flag or an unexpired timer', () => {
    expect(buildEffectiveConfig({}, parseControlState({ mute: true }), 1_000).muted).toBe(true);
    const timed = buildEffectiveConfig({}, parseControlState({ muteUntil: 2_000 }), 1_000);
    expect(timed.muted).toBe(true);
    expect(timed.mutedUntil).toBe(2_000);
    const expired = buildEffectiveConfig({}, parseControlState({ muteUntil: 500 }), 1_000);
    expect(expired.muted).toBe(false);
    expect(expired.mutedUntil).toBeNull();
  });

  it('normalizes control state, including provider aliases', () => {
    expect(parseControlState({ preferredProvider: 'SAY', voiceOverride: '  ', stopToken: 4 })).toEqual({
      mute: false,
      muteUntil: null,
      profileId: null,
      preferredProvider: 'system',
      voiceOverride: null,
    });
  });
});

describe('settings JSON schema', () => {
  it('describes every top-level setting and the profiles map', () => {
    const schema = settingsJsonSchema();
    const properties = schema.properties as Record<string, unknown>;
    for (const key of ['notification', 'ntfy', 'audio', 'queue', 'guardrails', 'modelsDir', 'providers', 'logging', 'profiles']) {
      expect(properties).toHaveProperty(key);
    }
    expect(JSON.stringify(schema)).toContain('"enum":["kokoro","piper","system","command","say","sapi","espeak"]');
  });
});

describe('parseJsonc', () => {
  it('accepts comments, trailing commas, and comment-like text inside strings', () => {
    const value = parseJsonc(`{
      // line comment
      "url": "https://example.com/a//b", /* block */
      "list": [1, 2,],
    }`);
    expect(value).toEqual({ url: 'https://example.com/a//b', list: [1, 2] });
  });

  it('keeps line structure across comments so parse errors point at the right line', () => {
    const text = '{\n/* one\ntwo\nthree */\n"a": 1, // note\n"b": 2\n}';
    const stripped = stripJsonc(text);
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length);
    expect(stripped.split('\n')[4]).toBe('"a": 1, ');
  });
});
