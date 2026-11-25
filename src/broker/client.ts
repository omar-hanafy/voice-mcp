import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

import type { AppPaths } from '../config/paths.js';
import { delay, errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { VERSION } from '../version.js';
import { decodeResponse, encodeRequest, LineReader, type BrokerRequest, type BrokerResponse } from './protocol.js';

const REQUEST_TIMEOUT_MS = 1_500;
const STARTUP_WAIT_MS = 3_000;
const STARTUP_POLL_MS = 50;

/** Send one request and wait for its response. Resolves null when the broker is unreachable. */
export function request(endpoint: string, message: BrokerRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BrokerResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(endpoint);
    const reader = new LineReader();
    const finish = (value: BrokerResponse | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
    socket.once('connect', () => socket.write(encodeRequest(message)));
    socket.on('data', (chunk: string) => reader.push(chunk, (line) => finish(decodeResponse(line))));
  });
}

/** Path of the script that hosts the broker: the running bundle unless a test overrides it. */
export function brokerEntry(): string {
  return process.env.VOICE_MCP_BROKER_ENTRY?.trim() || process.argv[1] || '';
}

function spawnBroker(logger: Logger): boolean {
  const entry = brokerEntry();
  if (!entry || !fs.existsSync(entry)) {
    logger.warn('Cannot start the broker: entry script not found', { entry });
    return false;
  }
  try {
    const child = spawn(process.execPath, [entry, 'broker'], {
      // Never inherit the caller's folder: on Windows a process's working directory cannot be
      // deleted or renamed, which would lock the user's project or an old plugin version.
      cwd: os.homedir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    return true;
  } catch (error) {
    logger.warn('Cannot start the broker', { error: errorMessage(error) });
    return false;
  }
}

async function waitForBroker(endpoint: string): Promise<BrokerResponse | null> {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await request(endpoint, { op: 'ping' }, 300);
    if (response?.ok) return response;
    await delay(STARTUP_POLL_MS);
  }
  return null;
}

/** Compare dotted numeric versions; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Return a running broker, starting one if needed. A broker from an older plugin version is
 * asked to exit first so upgrades take effect without a reboot. A newer broker is kept: when two
 * hosts have different plugin versions installed, the newest one wins instead of the two
 * replacing each other on every message.
 */
export async function ensureBroker(paths: AppPaths, logger: Logger): Promise<boolean> {
  const endpoint = paths.brokerEndpoint;
  const existing = await request(endpoint, { op: 'ping' }, 500);
  if (existing?.ok && compareVersions(existing.version, VERSION) >= 0) return true;

  if (existing?.ok) {
    logger.info('Replacing broker from another version', { running: existing.version, wanted: VERSION });
    await request(endpoint, { op: 'shutdown' });
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline && (await request(endpoint, { op: 'ping' }, 200))) await delay(STARTUP_POLL_MS);
  }

  if (!spawnBroker(logger)) return false;
  // Any healthy broker is acceptable here: a concurrent caller may have started a newer one.
  return (await waitForBroker(endpoint)) !== null;
}

/** Hand a line to the broker, starting it if necessary. Resolves true once it was accepted. */
export async function sendSpeak(params: {
  paths: AppPaths;
  logger: Logger;
  text: string;
  mirrorNtfy?: boolean;
}): Promise<boolean> {
  if (!(await ensureBroker(params.paths, params.logger))) return false;
  const response = await request(params.paths.brokerEndpoint, {
    op: 'speak',
    text: params.text,
    mirrorNtfy: params.mirrorNtfy ?? true,
  });
  return response?.ok === true;
}
