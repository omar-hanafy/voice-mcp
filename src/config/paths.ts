import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { osFamily, type OsFamily } from '../platform.js';

export interface AppPaths {
  /** Per-user data directory: settings, control state, status, logs. */
  dataDir: string;
  settingsPath: string;
  schemaPath: string;
  statePath: string;
  statusPath: string;
  logFilePath: string;
  /** Default location for downloaded Kokoro and Piper models. */
  defaultModelsDir: string;
  /** Scratch space for generated audio; private to this user and data directory. */
  tempDir: string;
  /** Unix socket path, or a Windows named pipe. */
  brokerEndpoint: string;
  /** Root of the installed plugin payload (contains assets/ and dist/). */
  pluginRoot: string;
  defaultChimePath: string;
}

export interface PathInputs {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  tempDir?: string;
  pluginRoot?: string;
}

/** Unix socket paths are limited to ~104 bytes on macOS and 108 on Linux, including the NUL. */
const MAX_SOCKET_PATH_BYTES = 100;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function expandHome(value: string, homeDir: string = os.homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

export function defaultDataDir(family: OsFamily, env: NodeJS.ProcessEnv, homeDir: string): string {
  switch (family) {
    case 'macos':
      return path.join(homeDir, 'Library', 'Application Support', 'voice-mcp');
    case 'windows':
      return path.join(nonEmpty(env.APPDATA) ?? path.join(homeDir, 'AppData', 'Roaming'), 'voice-mcp');
    case 'linux':
      return path.join(nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(homeDir, '.config'), 'voice-mcp');
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function brokerEndpointFor(params: {
  family: OsFamily;
  dataDir: string;
  tempDir: string;
}): string {
  const key = params.family === 'windows' ? params.dataDir.toLowerCase() : params.dataDir;
  const hash = shortHash(key);
  if (params.family === 'windows') {
    return `\\\\.\\pipe\\voice-mcp-${hash}`;
  }
  const preferred = path.join(params.dataDir, 'broker.sock');
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  return path.join(params.tempDir, `voice-mcp-${hash}.sock`);
}

function bundledPluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let depth = 0; depth < 5; depth += 1) {
    if (fs.existsSync(path.join(dir, 'assets', 'chime.wav'))) return dir;
    const nested = path.join(dir, 'plugin');
    if (fs.existsSync(path.join(nested, 'assets', 'chime.wav'))) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // The bundle lives at <pluginRoot>/dist/voice-mcp.mjs.
  return path.resolve(here, '..');
}

export function resolvePaths(inputs: PathInputs = {}): AppPaths {
  const env = inputs.env ?? process.env;
  const family = osFamily(inputs.platform);
  const homeDir = inputs.homeDir ?? os.homedir();
  // On Linux /tmp is shared between users; the per-user runtime dir is private by design. The XDG
  // spec requires it to be absolute, so a relative value is ignored.
  const runtimeDir = nonEmpty(env.XDG_RUNTIME_DIR);
  const systemTemp = path.resolve(
    inputs.tempDir ?? (family === 'linux' && runtimeDir && path.isAbsolute(runtimeDir) ? runtimeDir : os.tmpdir())
  );

  const override = nonEmpty(env.VOICE_MCP_HOME);
  const dataDir = path.resolve(
    override ? expandHome(override, homeDir) : defaultDataDir(family, env, homeDir)
  );
  const hash = shortHash(family === 'windows' ? dataDir.toLowerCase() : dataDir);
  const tempDir = path.join(systemTemp, `voice-mcp-${hash}`);

  const pluginRootOverride = nonEmpty(env.VOICE_MCP_PLUGIN_ROOT);
  const pluginRoot = path.resolve(
    pluginRootOverride ? expandHome(pluginRootOverride, homeDir) : (inputs.pluginRoot ?? bundledPluginRoot())
  );

  return {
    dataDir,
    settingsPath: path.join(dataDir, 'settings.jsonc'),
    schemaPath: path.join(dataDir, 'settings.schema.json'),
    statePath: path.join(dataDir, 'state.json'),
    statusPath: path.join(dataDir, 'status.json'),
    logFilePath: path.join(dataDir, 'logs', 'voice-mcp.log'),
    defaultModelsDir: path.join(dataDir, 'models'),
    tempDir,
    brokerEndpoint: brokerEndpointFor({ family, dataDir, tempDir: systemTemp }),
    pluginRoot,
    defaultChimePath: path.join(pluginRoot, 'assets', 'chime.wav'),
  };
}

/**
 * Resolve the models directory: environment override, then the settings value, then the
 * default under the data directory.
 */
export function resolveModelsDir(params: {
  paths: AppPaths;
  configured: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = params.env ?? process.env;
  const homeDir = params.homeDir ?? os.homedir();
  const fromEnv = nonEmpty(env.VOICE_MCP_MODELS_DIR);
  if (fromEnv) return path.resolve(expandHome(fromEnv, homeDir));
  if (params.configured) return path.resolve(expandHome(params.configured, homeDir));
  return params.paths.defaultModelsDir;
}
