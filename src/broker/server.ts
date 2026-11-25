import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { ProcessRunner } from '../audio/process-runner.js';
import { sweepDataDir } from '../config/files.js';
import type { AppPaths } from '../config/paths.js';
import { ConfigStore } from '../config/store.js';
import { osFamily, which } from '../platform.js';
import type { SpeechProvider } from '../speech/providers/types.js';
import type { ProviderId } from '../config/settings.js';
import { StatusReporter } from '../status/status.js';
import { errorCode, errorMessage } from '../util/errors.js';
import { AppLogger } from '../util/logger.js';
import { VERSION } from '../version.js';
import { request } from './client.js';
import { decodeRequest, encodeResponse, LineReader, type BrokerRequest, type BrokerResponse } from './protocol.js';
import { SpeechService } from './service.js';

const DEFAULT_IDLE_MS = 5 * 60_000;

export function resolveIdleMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IDLE_MS;
  return Math.trunc(Math.min(24 * 60 * 60_000, Math.max(100, parsed)));
}

type SocketIdentity = { dev: number; ino: number };

async function socketIdentity(endpoint: string): Promise<SocketIdentity | null> {
  if (osFamily() === 'windows') return null;
  try {
    const stat = await fsp.lstat(endpoint);
    return stat.isSocket() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

/** Remove the socket file only if it is still the one this broker created. */
async function unlinkOwnedSocket(endpoint: string, owned: SocketIdentity | null): Promise<void> {
  if (!owned) return;
  const current = await socketIdentity(endpoint);
  if (current && current.dev === owned.dev && current.ino === owned.ino) {
    await fsp.rm(endpoint, { force: true }).catch(() => undefined);
  }
}

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

/**
 * Bind the endpoint. Returns false when another live broker already owns it. A stale Unix
 * socket left by a crashed broker is removed and the bind retried once.
 */
async function bind(server: net.Server, endpoint: string, logger: AppLogger): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await listen(server, endpoint);
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EADDRINUSE') throw error;
      if (await request(endpoint, { op: 'ping' }, 300)) {
        logger.info('Another broker is already running; exiting');
        return false;
      }
      if (osFamily() === 'windows') return false;
      const stale = await socketIdentity(endpoint);
      if (stale) await unlinkOwnedSocket(endpoint, stale);
    }
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/** Delete scratch folders left by brokers that are no longer running. */
async function removeOrphanedWorkRoots(tempDir: string): Promise<void> {
  for (const name of await fsp.readdir(tempDir).catch(() => [] as string[])) {
    const match = /^broker-(\d+)-/.exec(name);
    if (match && Number(match[1]) !== process.pid && !isAlive(Number(match[1]))) {
      await fsp.rm(path.join(tempDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface BrokerOptions {
  paths: AppPaths;
  idleMs?: number;
  /** Test seams. */
  providers?: Readonly<Record<ProviderId, SpeechProvider>>;
  fetchImpl?: typeof fetch;
  exit?: (code: number) => void;
}

export interface RunningBroker {
  shutdown(reason: string): Promise<void>;
  service: SpeechService;
  closed: Promise<void>;
}

/**
 * The detached, per-user broker that owns the speech queue. Every MCP server, hook, and CLI
 * call talks to it, so speech from several agents never overlaps. It exits after a period of
 * inactivity and is restarted on demand.
 */
export async function startBroker(options: BrokerOptions): Promise<RunningBroker | null> {
  const { paths } = options;
  const logger = new AppLogger({ component: 'broker', stderr: false, filePath: paths.logFilePath });
  const config = new ConfigStore(paths, logger);
  await config.start();

  const applyLogging = () => {
    const { logging } = config.get().settings;
    logger.configure({ level: logging.level, filePath: logging.file ? paths.logFilePath : null });
  };
  applyLogging();

  // Each broker gets its own scratch folder, so a broker that loses the start-up race (or an
  // older one shutting down after an upgrade) can never delete audio the live broker is using.
  const workRoot = path.join(paths.tempDir, `broker-${process.pid}-${randomBytes(4).toString('hex')}`);
  const status = new StatusReporter(paths.statusPath, VERSION, logger);
  const runner = new ProcessRunner(logger, () => config.get().settings.audio.killGraceMs);
  const service = new SpeechService(
    config,
    status,
    {
      paths,
      runner,
      status,
      logger,
      family: osFamily(),
      find: (command) => which(command),
      env: process.env,
      workRoot,
      providers: options.providers,
    },
    logger,
    options.fetchImpl
  );

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shuttingDown = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const idleMs = options.idleMs ?? resolveIdleMs(process.env.VOICE_MCP_BROKER_IDLE_MS);

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (service.isIdle()) void shutdown('idle');
      else scheduleIdle();
    }, idleMs);
  };

  const handle = async (message: BrokerRequest): Promise<BrokerResponse> => {
    const ok = { ok: true as const, version: VERSION, pid: process.pid };
    switch (message.op) {
      case 'ping':
        return ok;
      case 'speak':
        void service.submit(message.text, message.mirrorNtfy);
        return { ...ok, queued: true };
      case 'stop':
        service.stopAll('stopped');
        status.noteStop();
        return ok;
      case 'reload':
        await config.reload();
        return ok;
      case 'shutdown':
        setImmediate(() => void shutdown('requested'));
        return ok;
    }
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const reader = new LineReader();
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      reader.push(chunk, (line) => {
        scheduleIdle();
        const message = decodeRequest(line);
        const reply = message
          ? handle(message).catch((error) => ({ ok: false as const, error: errorMessage(error) }))
          : Promise.resolve({ ok: false as const, error: 'unsupported request' });
        void reply.then((response) => {
          if (!socket.destroyed) socket.write(encodeResponse(response));
        });
      });
    });
  });

  await fsp.mkdir(paths.dataDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await bind(server, paths.brokerEndpoint, logger))) {
    config.dispose();
    return null;
  }
  const owned = await socketIdentity(paths.brokerEndpoint);
  if (owned) await fsp.chmod(paths.brokerEndpoint, 0o600).catch(() => undefined);

  // Housekeeping only once this broker owns the endpoint.
  await sweepDataDir(paths).catch(() => undefined);
  await removeOrphanedWorkRoots(paths.tempDir).catch(() => undefined);

  config.onChange((next, previous) => {
    applyLogging();
    status.setSettingsError(config.settingsError);
    if (next.muted && !previous.muted) {
      const affected = service.stopAll('muted');
      if (affected > 0) logger.info('Muted; stopped speech', { affected });
    }
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return closed;
    shuttingDown = true;
    logger.info('Broker shutting down', { reason });
    if (idleTimer) clearTimeout(idleTimer);
    server.close();
    service.stopAll('stopped');
    config.dispose();
    await status.close().catch(() => undefined);
    await unlinkOwnedSocket(paths.brokerEndpoint, owned);
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    // Remove the shared parent too when no other broker is using it (rmdir fails if not empty).
    await fsp.rmdir(paths.tempDir).catch(() => undefined);
    resolveClosed();
    options.exit?.(0);
    return closed;
  }

  status.setSettingsError(config.settingsError);
  await status.flush();
  scheduleIdle();
  logger.info('Broker ready', { version: VERSION, endpoint: paths.brokerEndpoint });
  return { shutdown, service, closed };
}
