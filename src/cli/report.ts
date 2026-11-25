import { request } from '../broker/client.js';
import { readControlState, readRawSettings } from '../config/files.js';
import type { AppPaths } from '../config/paths.js';
import { buildEffectiveConfig, type EffectiveConfig } from '../config/settings.js';
import { providerOrder } from '../speech/engine.js';
import type { StatusSnapshot } from '../status/status.js';
import { isPlainObject } from '../util/errors.js';
import { readTextIfExists } from '../util/fs.js';
import { VERSION } from '../version.js';

export interface StatusReport {
  version: string;
  broker: { running: boolean; version: string | null; pid: number | null; endpoint: string };
  muted: boolean;
  mutedUntil: number | null;
  profile: string | null;
  profiles: string[];
  preferredProvider: string | null;
  voiceOverride: string | null;
  providerOrder: string[];
  activity: StatusSnapshot['activity'];
  queueDepth: number;
  counters: StatusSnapshot['counters'] | null;
  lastSpokenAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  settingsError: string | null;
  paths: { dataDir: string; settings: string; log: string };
}

async function readStatusSnapshot(paths: AppPaths): Promise<StatusSnapshot | null> {
  try {
    const text = await readTextIfExists(paths.statusPath);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) && isPlainObject(parsed.activity) ? (parsed as unknown as StatusSnapshot) : null;
  } catch {
    return null;
  }
}

export async function loadEffectiveConfig(paths: AppPaths): Promise<{ config: EffectiveConfig; settingsError: string | null }> {
  const [raw, control] = await Promise.all([readRawSettings(paths), readControlState(paths)]);
  return { config: buildEffectiveConfig(raw.value ?? {}, control, Date.now()), settingsError: raw.error };
}

export async function gatherStatus(paths: AppPaths): Promise<StatusReport> {
  const [{ config, settingsError }, snapshot, ping] = await Promise.all([
    loadEffectiveConfig(paths),
    readStatusSnapshot(paths),
    request(paths.brokerEndpoint, { op: 'ping' }, 800),
  ]);
  const running = ping?.ok === true;
  // A snapshot from a broker that has since exited still holds useful history (last error,
  // counters), but its live fields are no longer true.
  const live = running && snapshot !== null;
  return {
    version: VERSION,
    broker: {
      running,
      version: ping?.ok ? ping.version : null,
      pid: ping?.ok ? ping.pid : null,
      endpoint: paths.brokerEndpoint,
    },
    muted: config.muted,
    mutedUntil: config.mutedUntil,
    profile: config.activeProfile,
    profiles: config.profiles,
    preferredProvider: config.control.preferredProvider,
    voiceOverride: config.control.voiceOverride,
    providerOrder: providerOrder(config),
    activity: live
      ? snapshot.activity
      : { state: 'idle', provider: null, voice: null, preview: null, since: null },
    queueDepth: live ? snapshot.queueDepth : 0,
    counters: live ? snapshot.counters : null,
    lastSpokenAt: snapshot?.lastSpokenAt ?? null,
    lastStopAt: snapshot?.lastStopAt ?? null,
    lastError: snapshot?.lastError ?? null,
    lastErrorAt: snapshot?.lastErrorAt ?? null,
    settingsError,
    paths: { dataDir: paths.dataDir, settings: paths.settingsPath, log: paths.logFilePath },
  };
}

function time(epoch: number | null): string {
  return epoch === null ? '-' : new Date(epoch).toLocaleString();
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `voice-mcp ${report.version}`,
    `broker:     ${report.broker.running ? `running (v${report.broker.version}, pid ${report.broker.pid})` : 'not running (starts on the next message)'}`,
    `muted:      ${report.muted ? (report.mutedUntil ? `until ${time(report.mutedUntil)}` : 'yes') : 'no'}`,
    `providers:  ${report.providerOrder.join(' -> ')}${report.preferredProvider && report.preferredProvider !== 'auto' ? ` (preferred: ${report.preferredProvider})` : ''}`,
    `voice:      ${report.voiceOverride ?? 'from settings'}`,
    `profile:    ${report.profile ?? 'none'}${report.profiles.length ? ` (available: ${report.profiles.join(', ')})` : ''}`,
    `activity:   ${report.activity.state}${report.activity.preview ? ` - "${report.activity.preview}"` : ''}`,
    `queue:      ${report.queueDepth}`,
    `last spoke: ${time(report.lastSpokenAt)}`,
  ];
  if (report.lastError) lines.push(`last error: ${report.lastError} (${time(report.lastErrorAt)})`);
  if (report.settingsError) lines.push(`settings:   ${report.settingsError}`);
  lines.push(`data dir:   ${report.paths.dataDir}`);
  return lines.join('\n');
}
