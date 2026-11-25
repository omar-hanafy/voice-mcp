import { request, sendSpeak } from '../broker/client.js';
import { ensureDataDir, updateControlState } from '../config/files.js';
import { resolveModelsDir, resolvePaths, type AppPaths } from '../config/paths.js';
import { PROVIDER_ALIASES, PROVIDER_IDS, type ControlState, type ProviderId } from '../config/settings.js';
import { osFamily, which, type OsFamily } from '../platform.js';
import { resolvePiperDataDir } from '../speech/providers/piper.js';
import { listVoices } from '../speech/voices.js';
import { errorMessage } from '../util/errors.js';
import { AppLogger } from '../util/logger.js';
import { VERSION } from '../version.js';
import { formatChecks, runDoctor } from './doctor.js';
import { downloadAll, kokoroDownloads, piperDownloads } from './models.js';
import { formatStatus, gatherStatus, loadEffectiveConfig } from './report.js';

export const USAGE = `voice-mcp ${VERSION} - spoken updates for coding agents

Usage: voice-mcp <command> [options]

Speech
  speak <text...> [--no-ntfy]   Say a line through the shared queue (exit 1 if undeliverable)
  test-voice [text...]          Say a sample line with the current voice settings
  stop                          Stop speaking and clear the queue

Mute
  mute | unmute | toggle-mute
  mute-for <minutes>            Mute until the timer runs out

Voice selection
  set-provider <auto|${PROVIDER_IDS.join('|')}>
  set-voice <voice> [--provider <id>] [--test]
                                Voice for the first provider tried (see: voices)
  set-profile <name>            Apply a named profile from settings.jsonc
  clear-provider | clear-voice | clear-profile
  voices [--provider <id>] [--json]

Setup and diagnostics
  status [--json]               Current state, including whether the broker is running
  doctor [--json]               Check settings, audio player, and speech providers
  models install kokoro         Download the Kokoro model files
  models install piper <voice>  Download a Piper voice, e.g. en_US-joe-medium
  paths [--json]                Show where settings, logs, and models live
  version

Entry points used by hosts
  mcp                           Run the stdio MCP server
  hook                          Run a lifecycle hook (reads the event JSON on stdin)
  broker                        Run the speech broker in the foreground

Environment: VOICE_MCP_HOME (data directory), VOICE_MCP_MODELS_DIR (models directory).
`;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], option: string): string | null {
  const index = args.indexOf(option);
  if (index < 0) return null;
  const value = args[index + 1] ?? null;
  args.splice(index, value === null ? 1 : 2);
  return value;
}

function parseProvider(raw: string | undefined): ProviderId | 'auto' | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'auto') return 'auto';
  if ((PROVIDER_IDS as readonly string[]).includes(value)) return value as ProviderId;
  return PROVIDER_ALIASES[value] ?? null;
}

interface Context {
  paths: AppPaths;
  family: OsFamily;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
  io: Io;
}

/** Persist a control-state change, then nudge a running broker so it applies immediately. */
async function control(ctx: Context, update: (state: ControlState) => Partial<ControlState>, message?: string): Promise<number> {
  await updateControlState(ctx.paths, update);
  await request(ctx.paths.brokerEndpoint, { op: 'reload' }, 800);
  ctx.io.out(message ?? 'OK');
  return 0;
}

async function speakCommand(ctx: Context, words: string[], mirrorNtfy: boolean): Promise<number> {
  const text = words.join(' ').trim();
  if (!text) {
    ctx.io.err('speak: nothing to say');
    return 2;
  }
  const logger = new AppLogger({ component: 'cli', level: 'error' });
  if (!(await sendSpeak({ paths: ctx.paths, logger, text, mirrorNtfy }))) {
    ctx.io.err('speak: the speech broker could not be reached (run `voice-mcp doctor`)');
    return 1;
  }
  ctx.io.out('OK');
  return 0;
}

async function voicesCommand(ctx: Context, args: string[]): Promise<number> {
  const json = takeFlag(args, '--json');
  const providerArg = takeOption(args, '--provider');
  const { config } = await loadEffectiveConfig(ctx.paths);
  const providers: ProviderId[] = providerArg
    ? (() => {
        const parsed = parseProvider(providerArg);
        return parsed && parsed !== 'auto' ? [parsed] : [];
      })()
    : ['system', 'kokoro', 'piper'];
  if (providers.length === 0) {
    ctx.io.err(`voices: unknown provider "${providerArg}"`);
    return 2;
  }
  const result: Record<string, Awaited<ReturnType<typeof listVoices>>> = {};
  for (const provider of providers) {
    result[provider] = await listVoices({ provider, settings: config.settings, paths: ctx.paths, family: ctx.family, find: ctx.find, env: ctx.env });
  }
  if (json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const [provider, voices] of Object.entries(result)) {
    ctx.io.out(`${provider}:${voices.length === 0 ? ' (none found)' : ''}`);
    for (const voice of voices) ctx.io.out(`  ${voice.id.padEnd(28)} ${voice.group}`);
  }
  return 0;
}

async function modelsCommand(ctx: Context, args: string[]): Promise<number> {
  const [action, kind, voice] = args;
  if (action !== 'install' || (kind !== 'kokoro' && kind !== 'piper')) {
    ctx.io.err('Usage: voice-mcp models install kokoro | voice-mcp models install piper <voice>');
    return 2;
  }
  const { config } = await loadEffectiveConfig(ctx.paths);
  const log = (line: string) => ctx.io.err(line);
  if (kind === 'kokoro') {
    const modelsDir = resolveModelsDir({ paths: ctx.paths, configured: config.settings.modelsDir, env: ctx.env });
    await downloadAll(kokoroDownloads(modelsDir), log);
    ctx.io.out('Kokoro model installed. Also install the CLI: pip install kokoro-tts');
    return 0;
  }
  const name = voice ?? config.settings.providers.piper.model;
  await downloadAll(piperDownloads(resolvePiperDataDir({ settings: config.settings, paths: ctx.paths, env: ctx.env }), name), log);
  ctx.io.out(`Piper voice ${name} installed. Also install the engine: pip install piper-tts`);
  return 0;
}

export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  const ctx: Context = {
    paths: resolvePaths(),
    family: osFamily(),
    find: (name) => which(name),
    env: process.env,
    io,
  };

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return 0;
      case 'version':
      case '--version':
      case '-v':
        io.out(VERSION);
        return 0;
      case 'paths': {
        const json = takeFlag(args, '--json');
        const { config } = await loadEffectiveConfig(ctx.paths);
        const report = {
          dataDir: ctx.paths.dataDir,
          settings: ctx.paths.settingsPath,
          state: ctx.paths.statePath,
          status: ctx.paths.statusPath,
          log: ctx.paths.logFilePath,
          models: resolveModelsDir({ paths: ctx.paths, configured: config.settings.modelsDir, env: ctx.env }),
          brokerEndpoint: ctx.paths.brokerEndpoint,
          pluginRoot: ctx.paths.pluginRoot,
        };
        io.out(json ? JSON.stringify(report, null, 2) : Object.entries(report).map(([k, v]) => `${k.padEnd(15)} ${v}`).join('\n'));
        return 0;
      }
      case 'status': {
        const json = takeFlag(args, '--json');
        await ensureDataDir(ctx.paths);
        const report = await gatherStatus(ctx.paths);
        io.out(json ? JSON.stringify(report, null, 2) : formatStatus(report));
        return 0;
      }
      case 'doctor': {
        const json = takeFlag(args, '--json');
        const checks = await runDoctor(ctx);
        io.out(json ? JSON.stringify(checks, null, 2) : formatChecks(checks));
        return checks.some((check) => check.level === 'fail') ? 1 : 0;
      }
      case 'speak': {
        const mirrorNtfy = !takeFlag(args, '--no-ntfy');
        return await speakCommand(ctx, args, mirrorNtfy);
      }
      case 'test-voice': {
        const { config } = await loadEffectiveConfig(ctx.paths);
        if (config.muted) io.err('Note: voice-mcp is muted, so nothing will play. Run `voice-mcp unmute` first.');
        const text = args.length > 0 ? args : ['This is a voice test. The quick brown fox jumps over the lazy dog.'];
        return await speakCommand(ctx, text, false);
      }
      case 'stop': {
        const response = await request(ctx.paths.brokerEndpoint, { op: 'stop' });
        io.out(response?.ok ? 'OK' : 'OK (nothing was playing)');
        return 0;
      }
      case 'mute':
        return await control(ctx, () => ({ mute: true, muteUntil: null }));
      case 'unmute':
        return await control(ctx, () => ({ mute: false, muteUntil: null }));
      case 'toggle-mute': {
        const next = await updateControlState(ctx.paths, (state) => ({
          mute: !(state.mute || (state.muteUntil !== null && state.muteUntil > Date.now())),
          muteUntil: null,
        }));
        await request(ctx.paths.brokerEndpoint, { op: 'reload' }, 800);
        io.out(next.mute ? 'muted' : 'unmuted');
        return 0;
      }
      case 'mute-for': {
        const minutes = Number(args[0]);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          io.err('Usage: voice-mcp mute-for <minutes>');
          return 2;
        }
        return await control(ctx, () => ({ mute: false, muteUntil: Date.now() + Math.round(minutes * 60_000) }));
      }
      case 'set-provider': {
        const provider = parseProvider(args[0]);
        if (!provider) {
          io.err(`Usage: voice-mcp set-provider <auto|${PROVIDER_IDS.join('|')}>`);
          return 2;
        }
        return await control(ctx, () => ({ preferredProvider: provider === 'auto' ? null : provider }));
      }
      case 'clear-provider':
        return await control(ctx, () => ({ preferredProvider: null }));
      case 'set-voice': {
        // --provider also prefers the voice's engine, so a Kokoro voice is never handed to Piper.
        // --test speaks a sample right away (used by menu-bar integrations).
        const test = takeFlag(args, '--test');
        const providerArg = takeOption(args, '--provider');
        const provider = providerArg === null ? undefined : parseProvider(providerArg);
        const voice = args.join(' ').trim();
        if (!voice || provider === null) {
          io.err(`Usage: voice-mcp set-voice <voice> [--provider <${PROVIDER_IDS.join('|')}>] [--test]`);
          return 2;
        }
        await control(ctx, () => ({
          voiceOverride: voice,
          ...(provider ? { preferredProvider: provider === 'auto' ? null : provider } : {}),
        }));
        return test ? await runCli(['test-voice'], io) : 0;
      }
      case 'clear-voice':
        return await control(ctx, () => ({ voiceOverride: null }));
      case 'set-profile': {
        const name = args.join(' ').trim();
        const { config } = await loadEffectiveConfig(ctx.paths);
        if (!name || !config.profiles.includes(name)) {
          io.err(`Unknown profile "${name}". Available: ${config.profiles.join(', ') || 'none (add them under "profiles" in settings.jsonc)'}`);
          return 2;
        }
        return await control(ctx, () => ({ profileId: name }));
      }
      case 'clear-profile':
        return await control(ctx, () => ({ profileId: null }));
      case 'voices':
        return await voicesCommand(ctx, args);
      case 'models':
        return await modelsCommand(ctx, args);
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(`voice-mcp ${command}: ${errorMessage(error)}`);
    return 1;
  }
}
