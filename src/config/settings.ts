import { isPlainObject } from '../util/errors.js';
import {
  boolean,
  choiceList,
  integer,
  nullableInteger,
  nullableObject,
  nullableOneOf,
  nullableString,
  number,
  object,
  oneOf,
  optionalString,
  string,
  stringList,
  type Infer,
  type JsonSchema,
} from './spec.js';

export const PROVIDER_IDS = ['kokoro', 'piper', 'system', 'command'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Older names for the built-in OS voice. `say` was the only built-in voice before Windows support. */
export const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  say: 'system',
  sapi: 'system',
  espeak: 'system',
};

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const panicMuteSpec = object(
  {
    enabled: boolean(true),
    threshold: integer(30, { min: 1, max: 10_000 }, 'Dropped messages within the window that trip the fuse.'),
    windowMs: integer(60_000, { min: 1_000, max: 3_600_000 }),
    muteForMs: integer(300_000, { min: 1_000, max: 86_400_000 }),
  },
  'In-memory safety fuse: if messages are dropped too fast, stay silent for a while. Never written to state.json.'
);

export const settingsSpec = object({
  notification: object(
    {
      enabled: boolean(true, 'Play a short chime before each spoken message.'),
      path: nullableString(null, 'WAV file to play instead of the bundled chime. Supports ~ for your home folder.'),
    },
    'Chime played before speech.'
  ),
  ntfy: object(
    {
      enabled: boolean(false),
      server: string('https://ntfy.sh'),
      topic: optionalString('', 'Topic to publish to. Anyone who knows an open topic name can read it, so use a long random name or a token.'),
      token: nullableString(null, 'Bearer token for protected topics.'),
      title: string('Voice'),
      priority: integer(4, { min: 1, max: 5 }),
      maxBodyChars: integer(0, { min: 0, max: 4096 }, '0 sends the full line; otherwise trim to this many characters.'),
    },
    'Mirror every accepted line to an ntfy topic (https://ntfy.sh or self-hosted), including while muted.'
  ),
  audio: object({
    player: nullableString(
      null,
      'Audio player command. null picks the platform default: afplay on macOS, PowerShell SoundPlayer on Windows, and paplay/aplay/ffplay on Linux.'
    ),
    playerArgs: stringList([], 'Extra arguments placed before the audio file, e.g. ["-v", "0.6"] for afplay volume.'),
    generationTimeoutMs: integer(600_000, { min: 1_000, max: 3_600_000 }),
    playbackTimeoutMs: integer(600_000, { min: 1_000, max: 3_600_000 }),
    killGraceMs: integer(1_500, { min: 100, max: 30_000 }, 'Time between a polite stop and a forced kill.'),
  }),
  queue: object({
    maxDepth: integer(12, { min: 1, max: 250 }),
    dropPolicy: oneOf(['oldest', 'newest'] as const, 'oldest', {
      description: 'When full: "oldest" drops queued items to make room, "newest" drops the new request.',
    }),
  }),
  guardrails: object({
    enabled: boolean(true),
    maxCharsPerMessage: integer(400, { min: 1, max: 20_000 }, 'Longer messages are dropped.'),
    cooldownMs: integer(1_200, { min: 0, max: 60_000 }, 'Minimum time between accepted messages.'),
    maxMessagesPerMinute: integer(10, { min: 0, max: 600 }, 'Token-bucket refill rate. 0 disables the rate limit.'),
    burst: integer(3, { min: 1, max: 120 }, 'Token-bucket capacity.'),
    dedupeWindowMs: integer(15_000, { min: 0, max: 600_000 }, 'Drop exact repeats seen within this window.'),
    panicMuteOnDrops: nullableObject(panicMuteSpec),
  }),
  modelsDir: nullableString(
    null,
    'Where Kokoro and Piper models live. null uses the models folder inside the Voice MCP data directory. VOICE_MCP_MODELS_DIR overrides this.'
  ),
  providers: object({
    order: choiceList(PROVIDER_IDS, ['kokoro', 'piper', 'system'], {
      aliases: PROVIDER_ALIASES,
      description:
        'Providers to try in order; the first that succeeds speaks. "system" is the built-in OS voice and needs no setup.',
    }),
    kokoro: object({
      cli: string('kokoro-tts', 'kokoro-tts executable name or path.'),
      modelPath: nullableString(null, 'null uses <modelsDir>/kokoro/kokoro-v1.0.onnx or KOKORO_MODEL_PATH.'),
      voicesPath: nullableString(null, 'null uses <modelsDir>/kokoro/voices-v1.0.bin or KOKORO_VOICES_PATH.'),
      voice: string('am_michael'),
      lang: string('en-us'),
      speed: number(1, { min: 0.5, max: 2 }),
    }),
    piper: object({
      python: nullableString(null, 'Python that has piper-tts installed. null uses "python" on Windows and "python3" elsewhere.'),
      dataDir: nullableString(null, 'Directory with .onnx voices. null uses <modelsDir>/piper or PIPER_DATA_DIR.'),
      model: string('en_US-joe-medium'),
    }),
    system: object(
      {
        voice: nullableString(null, 'OS voice name. Run `voice-mcp voices` to list them. null uses the system default.'),
        rate: nullableInteger(null, { min: 50, max: 600 }, 'Speaking rate in words per minute. null uses the system default (about 175).'),
      },
      'Built-in OS voice: `say` on macOS, SAPI (System.Speech) on Windows, espeak-ng on Linux.'
    ),
    command: object(
      {
        command: nullableString(null, 'Any TTS executable. Leave null to disable this provider.'),
        args: stringList(
          [],
          'Arguments. Placeholders: {text}, {textFile}, {outFile}, {voice}. With {outFile} the file is played afterwards; without it the command is expected to speak by itself.'
        ),
      },
      'Bring-your-own TTS command.'
    ),
  }),
  logging: object({
    level: oneOf(LOG_LEVELS, 'info'),
    file: boolean(true, 'Also append logs to logs/voice-mcp.log in the data directory.'),
  }),
});

export type Settings = Infer<typeof settingsSpec>;

export const controlStateSpec = object({
  mute: boolean(false),
  muteUntil: nullableInteger(null, { min: 0, max: Number.MAX_SAFE_INTEGER }),
  profileId: nullableString(null),
  preferredProvider: nullableOneOf(['auto', ...PROVIDER_IDS] as const, null, { aliases: PROVIDER_ALIASES }),
  voiceOverride: nullableString(null),
});

export type ControlState = Infer<typeof controlStateSpec>;

export interface EffectiveConfig {
  settings: Settings;
  control: ControlState;
  /** The profile that was actually applied (null when unset or unknown). */
  activeProfile: string | null;
  profiles: string[];
  muted: boolean;
  mutedUntil: number | null;
}

/** Map pre-0.5 keys onto the current shape so older settings files keep working. */
function migrateLegacyKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const providers = raw.providers;
  if (isPlainObject(providers) && providers.say !== undefined && providers.system === undefined) {
    return { ...raw, providers: { ...providers, system: providers.say } };
  }
  return raw;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

export function profileNames(raw: unknown): string[] {
  if (!isPlainObject(raw) || !isPlainObject(raw.profiles)) return [];
  return Object.entries(raw.profiles)
    .filter(([name, value]) => name.trim().length > 0 && isPlainObject(value))
    .map(([name]) => name)
    .sort();
}

/**
 * Build the effective settings from the raw settings document. A selected profile is
 * deep-merged over the base document before parsing, so a profile may override any field.
 */
export function parseSettings(raw: unknown, profileId: string | null = null): Settings {
  const base = isPlainObject(raw) ? migrateLegacyKeys(raw) : {};
  const profiles = isPlainObject(base.profiles) ? base.profiles : {};
  const profile = profileId ? profiles[profileId] : undefined;
  const merged = isPlainObject(profile) ? deepMerge(base, migrateLegacyKeys(profile)) : base;
  return settingsSpec.parse(merged);
}

export function parseControlState(raw: unknown): ControlState {
  return controlStateSpec.parse(raw);
}

export function buildEffectiveConfig(rawSettings: unknown, control: ControlState, now: number): EffectiveConfig {
  const profiles = profileNames(rawSettings);
  const activeProfile = control.profileId && profiles.includes(control.profileId) ? control.profileId : null;
  const settings = parseSettings(rawSettings, activeProfile);
  const timedMute = control.muteUntil !== null && control.muteUntil > now;
  return {
    settings,
    control,
    activeProfile,
    profiles,
    muted: control.mute || timedMute,
    mutedUntil: timedMute ? control.muteUntil : null,
  };
}

export function settingsJsonSchema(): JsonSchema {
  const base = settingsSpec.jsonSchema();
  const properties = (base.properties ?? {}) as Record<string, JsonSchema>;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Voice MCP settings',
    ...base,
    properties: {
      $schema: { type: 'string' },
      ...properties,
      profiles: {
        type: 'object',
        description:
          'Named overrides, selected with `voice-mcp set-profile <name>`. Each profile may override any setting above.',
        additionalProperties: { type: 'object', properties, additionalProperties: true },
      },
    },
  };
}
