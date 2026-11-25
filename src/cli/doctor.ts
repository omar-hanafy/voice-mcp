import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { describeDefaultPlayer, findDefaultPlayer } from '../audio/player.js';
import { request } from '../broker/client.js';
import { ensureDataDir } from '../config/files.js';
import { expandHome, resolveModelsDir, type AppPaths } from '../config/paths.js';
import { PROVIDER_IDS } from '../config/settings.js';
import { OS_LABEL, type OsFamily } from '../platform.js';
import { checkProvider } from '../speech/availability.js';
import { providerOrder } from '../speech/engine.js';
import { errorMessage } from '../util/errors.js';
import { VERSION } from '../version.js';
import { loadEffectiveConfig } from './report.js';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  level: CheckLevel;
  name: string;
  detail: string;
  hint?: string;
}

export async function runDoctor(params: {
  paths: AppPaths;
  family: OsFamily;
  find: (command: string) => string | null;
  env: NodeJS.ProcessEnv;
}): Promise<Check[]> {
  const { paths, family, find, env } = params;
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  const major = Number(process.versions.node.split('.')[0]);
  add({
    level: major >= 20 ? 'ok' : 'fail',
    name: 'Node.js',
    detail: `${process.versions.node} on ${OS_LABEL[family]} (${process.arch}); voice-mcp ${VERSION}`,
    ...(major >= 20 ? {} : { hint: 'Install Node.js 20 or newer.' }),
  });

  try {
    await ensureDataDir(paths);
    const probe = path.join(paths.dataDir, `.doctor-${process.pid}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    add({ level: 'ok', name: 'Data directory', detail: paths.dataDir });
  } catch (error) {
    add({ level: 'fail', name: 'Data directory', detail: `${paths.dataDir}: ${errorMessage(error)}`, hint: 'Set VOICE_MCP_HOME to a writable folder.' });
  }

  const { config, settingsError } = await loadEffectiveConfig(paths);
  const settings = config.settings;
  add(
    settingsError
      ? { level: 'fail', name: 'Settings', detail: settingsError, hint: 'Fix the file; until then the last valid settings (or defaults) apply.' }
      : { level: 'ok', name: 'Settings', detail: paths.settingsPath }
  );

  const playerName = settings.audio.player;
  const player = playerName ? find(expandHome(playerName)) : findDefaultPlayer(family, find);
  add(
    player
      ? { level: 'ok', name: 'Audio player', detail: playerName ? player : `${describeDefaultPlayer(family)} (${player})` }
      : {
          level: 'fail',
          name: 'Audio player',
          detail: playerName ? `${playerName} not found` : `none of ${describeDefaultPlayer(family)} found`,
          hint: family === 'linux' ? 'Install pulseaudio-utils, alsa-utils, or ffmpeg.' : 'Set audio.player to a working player, or null for the default.',
        }
  );

  if (settings.notification.enabled) {
    const chime = settings.notification.path ? path.resolve(expandHome(settings.notification.path)) : paths.defaultChimePath;
    add(fs.existsSync(chime) ? { level: 'ok', name: 'Chime', detail: chime } : { level: 'warn', name: 'Chime', detail: `missing: ${chime}` });
  } else {
    add({ level: 'info', name: 'Chime', detail: 'disabled' });
  }

  add({ level: 'info', name: 'Models directory', detail: resolveModelsDir({ paths, configured: settings.modelsDir, env }) });

  const order = providerOrder(config);
  let usable = 0;
  for (const id of PROVIDER_IDS) {
    const enabled = order.includes(id);
    const availability = checkProvider({ id, settings, paths, family, find, env });
    if (availability.available && enabled) usable += 1;
    add({
      level: !enabled ? 'info' : availability.available ? 'ok' : 'warn',
      name: `Provider: ${id}`,
      detail: `${enabled ? `#${order.indexOf(id) + 1} in order` : 'not in providers.order'} - ${availability.detail}`,
      ...(availability.hint && enabled && !availability.available ? { hint: availability.hint } : {}),
    });
  }
  if (usable === 0) {
    add({ level: 'fail', name: 'Speech', detail: 'no enabled provider is ready', hint: 'Add "system" to providers.order or install a provider.' });
  }

  const ping = await request(paths.brokerEndpoint, { op: 'ping' }, 800);
  add({
    level: 'info',
    name: 'Broker',
    detail: ping?.ok ? `running v${ping.version} (pid ${ping.pid}) at ${paths.brokerEndpoint}` : `not running; starts on demand at ${paths.brokerEndpoint}`,
  });

  add({
    level: config.muted ? 'warn' : 'ok',
    name: 'Mute',
    detail: config.muted ? (config.mutedUntil ? `muted until ${new Date(config.mutedUntil).toLocaleString()}` : 'muted') : 'not muted',
    ...(config.muted ? { hint: 'voice-mcp unmute' } : {}),
  });

  const ntfy = settings.ntfy;
  if (ntfy.enabled) {
    // Never print the topic: on an open server the topic name is the only access control.
    add(
      ntfy.topic
        ? { level: 'ok', name: 'ntfy mirror', detail: `enabled on ${ntfy.server}${ntfy.token ? ' with token' : ' (open topic)'}` }
        : { level: 'warn', name: 'ntfy mirror', detail: 'enabled but topic is empty' }
    );
  }

  return checks;
}

const MARK: Record<CheckLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks
    .map((check) => {
      const line = `[${MARK[check.level]}] ${check.name.padEnd(width)}  ${check.detail}`;
      return check.hint ? `${line}\n       ${' '.repeat(width)}  -> ${check.hint}` : line;
    })
    .join('\n');
}
