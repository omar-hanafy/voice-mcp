#!/usr/bin/env node
// <swiftbar.title>Voice MCP</swiftbar.title>
// <swiftbar.version>0.5.0</swiftbar.version>
// <swiftbar.author>Omar Khaled</swiftbar.author>
// <swiftbar.desc>Mute, stop, and choose voices for voice-mcp from the macOS menu bar.</swiftbar.desc>
// <swiftbar.dependencies>node</swiftbar.dependencies>
// <swiftbar.abouturl>https://github.com/omar-hanafy/voice-mcp</swiftbar.abouturl>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
//
// A thin menu over the voice-mcp CLI: every read and every action goes through it, so the menu
// always agrees with what agents and scripts see. Symlink this file into your SwiftBar plugins
// folder from a stable checkout (not an installed-plugin cache, which updates replace).
// VOICE_MCP_CLI overrides the CLI location; VOICE_MCP_HOME is passed through as usual.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const CLI = process.env.VOICE_MCP_CLI || path.resolve(HERE, '..', '..', 'plugin', 'dist', 'voice-mcp.mjs');
const STOPPED_ICON_MS = 30_000;

const out = (line) => process.stdout.write(`${line}\n`);

function cli(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  });
}

function cliJson(args, fallback) {
  try {
    return JSON.parse(cli(args));
  } catch {
    return fallback;
  }
}

/** SwiftBar parameter value: quote anything with spaces or quotes. */
function param(value) {
  const text = String(value);
  return /[\s"'|]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** A menu item that runs the CLI in the background and refreshes the menu. */
function action(label, args, extra = '') {
  const params = [CLI, ...args].map((value, index) => `param${index + 1}=${param(value)}`).join(' ');
  return `${label} | bash=${param(process.execPath)} ${params} terminal=false refresh=true${extra ? ` ${extra}` : ''}`;
}

function open(label, target, symbol) {
  return `${label} | bash=/usr/bin/open param1=${param(target)} terminal=false sfimage=${symbol}`;
}

function clock(epoch) {
  const date = new Date(epoch);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function groupBy(voices) {
  const groups = new Map();
  for (const voice of voices) {
    if (!groups.has(voice.group)) groups.set(voice.group, []);
    groups.get(voice.group).push(voice);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function render() {
  if (!fs.existsSync(CLI)) {
    out('voice | sfimage=exclamationmark.triangle');
    out('---');
    out(`voice-mcp CLI not found | color=red`);
    out(`${CLI} | size=11`);
    out('Set VOICE_MCP_CLI or symlink this file from a voice-mcp checkout. | size=11 color=gray');
    return;
  }

  const status = cliJson(['status', '--json'], null);
  if (!status) {
    out('voice | sfimage=mic.badge.xmark');
    out('---');
    out('Status unavailable | color=orange');
    out(action('Run Diagnostics', ['doctor']).replace('terminal=false', 'terminal=true'));
    return;
  }

  const stopped = status.lastStopAt !== null && Date.now() - status.lastStopAt < STOPPED_ICON_MS;
  const icon = stopped ? 'mic.badge.xmark' : status.muted ? 'mic.slash' : status.activity.state === 'idle' ? 'mic' : 'waveform';
  out(`​ | sfimage=${icon}`);
  out('---');

  out(
    status.muted
      ? action('Unmute', ['unmute'], 'sfimage=speaker.wave.2 shortcut=CMD+SHIFT+M')
      : action('Mute', ['mute'], 'sfimage=speaker.slash shortcut=CMD+SHIFT+M')
  );
  out(action('Stop Speaking', ['stop'], 'sfimage=stop.circle shortcut=CMD+SHIFT+X'));
  out(action('Test Voice', ['test-voice'], 'sfimage=waveform'));
  if (status.activity.state !== 'idle' && status.activity.preview) {
    out(`${status.activity.state === 'playing' ? 'Speaking' : 'Preparing'}: ${status.activity.preview.slice(0, 60)} | size=11 color=gray`);
  }
  out('---');

  out('Mute For | sfimage=timer');
  for (const [label, minutes] of [['5 minutes', 5], ['15 minutes', 15], ['30 minutes', 30], ['1 hour', 60], ['2 hours', 120]]) {
    out(`--${action(label, ['mute-for', String(minutes)])}`);
  }
  if (status.mutedUntil) {
    out(`--Muted until ${clock(status.mutedUntil)} | color=red`);
    out(`--${action('Cancel Timer', ['unmute'])}`);
  }

  const preferred = status.preferredProvider ?? 'auto';
  out('Provider | sfimage=cpu');
  for (const [id, label] of [['auto', 'Auto (settings order)'], ['system', 'System'], ['kokoro', 'Kokoro'], ['piper', 'Piper'], ['command', 'Command']]) {
    out(`--${action(label, ['set-provider', id], preferred === id ? 'checked=true' : '')}`);
  }

  const voices = cliJson(['voices', '--json'], {});
  out('Voice | sfimage=person.wave.2');
  out(`--${action('From Settings', ['clear-voice'], status.voiceOverride ? '' : 'checked=true')}`);
  for (const [provider, label] of [['system', 'System'], ['kokoro', 'Kokoro'], ['piper', 'Piper']]) {
    const list = voices[provider] ?? [];
    if (list.length === 0) continue;
    out(`--${label}`);
    for (const [group, entries] of groupBy(list)) {
      out(`----${group}`);
      for (const voice of entries) {
        const checked = status.voiceOverride === voice.id && (status.preferredProvider ?? provider) === provider;
        out(`------${action(voice.label, ['set-voice', voice.id, '--provider', provider, '--test'], checked ? 'checked=true' : '')}`);
      }
    }
  }

  if (status.profiles.length > 0) {
    out('Profile | sfimage=list.bullet.rectangle');
    out(`--${action('None', ['clear-profile'], status.profile ? '' : 'checked=true')}`);
    for (const profile of status.profiles) {
      out(`--${action(profile, ['set-profile', profile], status.profile === profile ? 'checked=true' : '')}`);
    }
  }
  out('---');

  if (status.settingsError || status.lastError) {
    out('Problems | sfimage=exclamationmark.triangle color=orange');
    if (status.settingsError) out(`--Settings: ${status.settingsError.slice(0, 120)} | size=11`);
    if (status.lastError) out(`--Last error ${status.lastErrorAt ? `(${clock(status.lastErrorAt)})` : ''}: ${status.lastError.slice(0, 120)} | size=11`);
  }
  out('Tools | sfimage=wrench.and.screwdriver');
  out(`--${action('Run Diagnostics', ['doctor']).replace('terminal=false', 'terminal=true')} sfimage=stethoscope`);
  out(`--${open('Edit Settings', status.paths.settings, 'gearshape')}`);
  out(`--${open('Open Log', status.paths.log, 'doc.text')}`);
  out(`--${open('Open Data Folder', status.paths.dataDir, 'folder')}`);
  out('---');
  out(`voice-mcp ${status.version} - broker ${status.broker.running ? 'running' : 'idle'} | size=10 color=gray`);
}

render();
