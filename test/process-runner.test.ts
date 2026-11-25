import { describe, expect, it } from 'vitest';

import { CommandError, ProcessRunner } from '../src/audio/process-runner.js';
import { silentLogger } from '../src/util/logger.js';

const node = process.execPath;
const runner = () => new ProcessRunner(silentLogger, () => 200);

describe('ProcessRunner', () => {
  it('resolves when the command succeeds', async () => {
    await expect(runner().run(node, ['-e', 'process.exit(0)'], { label: 'ok', timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it('includes stderr in the failure message', async () => {
    const error = await runner()
      .run(node, ['-e', 'console.error("bad voice"); process.exit(3)'], { label: 'tts', timeoutMs: 5_000, captureStderr: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).reason).toBe('failed');
    expect((error as Error).message).toMatch(/tts failed \(exit code 3\) - bad voice/);
  });

  it('reports a missing command as unavailable to spawn', async () => {
    const error = await runner()
      .run('definitely-not-a-real-command-xyz', [], { label: 'missing', timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect((error as CommandError).reason).toBe('spawn');
  });

  it('kills the process when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runner().run(node, ['-e', 'setTimeout(() => {}, 30000)'], { label: 'long', timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort('stopped'), 100);
    const error = await pending.catch((e: unknown) => e);
    expect((error as CommandError).reason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('force-kills a process that ignores SIGTERM', async () => {
    const r = runner();
    const pending = r.run(node, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'], { label: 'stubborn', timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    expect(r.stopActive('test')).toBe(true);
    await pending.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.activeLabel).toBeNull();
  });

  it('times out', async () => {
    const error = await runner()
      .run(node, ['-e', 'setTimeout(() => {}, 30000)'], { label: 'slow', timeoutMs: 150 })
      .catch((e: unknown) => e);
    expect((error as CommandError).reason).toBe('timeout');
  });

  it('stops helper processes the command started, without waiting for them', async () => {
    // The command starts a long-lived helper that inherits stderr, like a TTS wrapper script.
    const pidFile = (await import('node:path')).join((await import('node:os')).tmpdir(), `vmcp-helper-${process.pid}-${Date.now()}`);
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'ignore', 'inherit'] });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));`,
      'setTimeout(() => {}, 30000);',
    ].join('\n');
    const controller = new AbortController();
    const pending = runner().run(node, ['-e', script], { label: 'wrapper', timeoutMs: 60_000, signal: controller.signal, captureStderr: true });
    const fs = await import('node:fs');
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const helperPid = Number(fs.readFileSync(pidFile, 'utf8'));
    fs.rmSync(pidFile, { force: true });

    const started = Date.now();
    controller.abort('stopped');
    const error = await pending.catch((e: unknown) => e);
    expect((error as CommandError).reason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);

    const alive = () => {
      try {
        process.kill(helperPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = Date.now() + 3_000;
    while (alive() && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it('settles when the command exits even if a helper keeps stderr open', async () => {
    const script =
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: false }); process.exit(0);";
    const started = Date.now();
    await runner().run(node, ['-e', script], { label: 'quick', timeoutMs: 10_000, captureStderr: true });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
