#!/usr/bin/env node
/**
 * Installs this repository's plugin into isolated Claude Code, Codex, and Antigravity homes,
 * then launches the installed MCP server and hooks the way each host does on this OS:
 *
 *   Claude Code  substitutes ${CLAUDE_PLUGIN_ROOT}; hooks run in sh (Git Bash or PowerShell on
 *                Windows) from an unrelated working directory.
 *   Codex        MCP `cwd: "."` resolves to the plugin root with no substitution; hooks get
 *                ${PLUGIN_ROOT} substituted and run in sh (PowerShell on Windows).
 *   Antigravity  MCP `cwd: "."` resolves to the plugin root; hooks run in the plugin root via
 *                sh -c (cmd /c on Windows).
 *
 * Each check speaks one line through a fake TTS command, so nothing is audible. Hosts whose CLI
 * is not installed are skipped. Usage: node scripts/verify-hosts.mjs [claude] [codex] [agy]
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const requested = process.argv.slice(2);
const results = [];

function which(command) {
  const finder = WINDOWS ? 'where' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(command, args, options = {}) {
  // npm-installed CLIs are .cmd shims on Windows, which need a shell; quote arguments for it.
  const shell = WINDOWS && !command.endsWith('.exe');
  const finalArgs = shell ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args;
  const result = spawnSync(command, finalArgs, { encoding: 'utf8', shell, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Fresh voice-mcp data dir wired to a fake TTS engine and player. */
function makeVoiceHome(root) {
  const home = path.join(root, 'voice-home');
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(root, 'spoken.log');
  const tool = path.join(root, 'fake-tts.mjs');
  fs.writeFileSync(
    tool,
    `import fs from 'node:fs';
const a = process.argv.slice(2);
const out = a.indexOf('--out');
if (out >= 0) fs.writeFileSync(a[out + 1], 'x');
if (!a.includes('--player')) fs.appendFileSync(${JSON.stringify(log)}, a.at(-1) + '\\n');
`
  );
  fs.writeFileSync(
    path.join(home, 'settings.jsonc'),
    JSON.stringify({
      notification: { enabled: false },
      audio: { player: process.execPath, playerArgs: [tool, '--player'] },
      providers: { order: ['command'], command: { command: process.execPath, args: [tool, '--out', '{outFile}', '{text}'] } },
      guardrails: { cooldownMs: 0 },
    })
  );
  return { home, log };
}

async function waitForLine(log, text, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`"${text}" was never spoken`);
}

/** Ask the broker for this data dir to exit so no process outlives the check. */
async function stopBroker(env) {
  const out = spawnSync(process.execPath, [path.join(REPO, 'plugin', 'dist', 'voice-mcp.mjs'), 'paths', '--json'], { env, encoding: 'utf8' });
  const endpoint = JSON.parse(out.stdout).brokerEndpoint;
  await new Promise((resolve) => {
    const socket = net.createConnection(endpoint, () => socket.write('{"op":"shutdown"}\n'));
    socket.on('data', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', resolve);
    socket.on('close', resolve);
  });
}

async function checkMcp({ label, command, args, cwd, env, log }) {
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: 'pipe' });
  const client = new Client({ name: 'verify-hosts', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === 'speak')) throw new Error('speak tool missing');
    const text = `${label} MCP speak works.`;
    await client.callTool({ name: "speak", arguments: { text } });
    await waitForLine(log, text);
  } finally {
    await client.close();
  }
}

function hookShell(host, command) {
  if (!WINDOWS) return { file: 'sh', args: ['-c', command] };
  if (host === 'agy') return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  if (host === 'claude') {
    // Claude Code uses Git Bash: CLAUDE_CODE_GIT_BASH_PATH, else bash.exe beside git.exe.
    const git = which('git');
    const candidates = [
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
      git && path.join(path.dirname(git), '..', 'bin', 'bash.exe'),
      git && path.join(path.dirname(git), 'bash.exe'),
    ].filter(Boolean);
    const bash = candidates.find((candidate) => fs.existsSync(candidate));
    if (bash) return { file: bash, args: ['-c', command] };
  }
  return { file: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
}

async function checkHook({ host, label, command, cwd, env, log, expectStdout }) {
  const text = `${label} hook works.`;
  const payload =
    host === 'agy'
      ? { conversationId: 'c', hookEventName: 'Stop', fullyIdle: true, transcriptPath: '' }
      : { hook_event_name: 'Stop', last_assistant_message: text };
  const shell = hookShell(host, command);
  const result = spawnSync(shell.file, shell.args, { cwd, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  if (result.stdout.trim() !== expectStdout) throw new Error(`unexpected hook output: ${JSON.stringify(result.stdout)}`);
  await waitForLine(log, host === 'agy' ? 'The agent finished responding' : text);
}

async function verify(host, fn) {
  console.error(`checking ${host}...`);
  if (requested.length && !requested.includes(host)) return;
  const binary = which(host);
  if (!binary) {
    results.push([host, 'skipped', 'CLI not installed']);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `voice-mcp-${host}-`));
  const { home, log } = makeVoiceHome(root);
  const env = { ...process.env, VOICE_MCP_HOME: home, VOICE_MCP_BROKER_IDLE_MS: '15000' };
  const elsewhere = fs.mkdtempSync(path.join(root, 'cwd-'));
  try {
    await fn({ root, env, log, elsewhere });
    results.push([host, 'ok', '']);
  } catch (error) {
    results.push([host, 'FAILED', error instanceof Error ? error.message : String(error)]);
  } finally {
    await stopBroker(env);
    // Give the broker a moment to exit before deleting its data directory.
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await verify('claude', async ({ root, env, log, elsewhere }) => {
  const hostEnv = { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') };
  run('claude', ['plugin', 'marketplace', 'add', REPO, '--scope', 'user'], { env: hostEnv });
  run('claude', ['plugin', 'install', '--scope', 'user', 'voice-mcp@voice-mcp'], { env: hostEnv });
  const installed = JSON.parse(run('claude', ['plugin', 'list', '--json'], { env: hostEnv })).find((p) => p.id === 'voice-mcp@voice-mcp');
  if (!installed?.enabled) throw new Error('plugin not installed or not enabled');
  const pluginRoot = installed.installPath;
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const subst = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', WINDOWS ? pluginRoot.replaceAll('\\', '/') : pluginRoot);
  const server = manifest.mcpServers['voice-mcp'];
  await checkMcp({ label: 'Claude', command: server.command, args: server.args.map(subst), cwd: elsewhere, env: { ...hostEnv, CLAUDE_PLUGIN_ROOT: pluginRoot }, log });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.hooks), 'utf8'));
  await checkHook({
    host: 'claude',
    label: 'Claude',
    command: subst(hooks.hooks.Stop[0].hooks[0].command),
    cwd: elsewhere,
    env: { ...hostEnv, CLAUDE_PLUGIN_ROOT: pluginRoot },
    log,
    expectStdout: '{}',
  });
});

await verify('codex', async ({ root, env, log, elsewhere }) => {
  const hostEnv = { ...env, CODEX_HOME: path.join(root, 'codex-home') };
  fs.mkdirSync(hostEnv.CODEX_HOME, { recursive: true });
  run('codex', ['plugin', 'marketplace', 'add', REPO, '--json'], { env: hostEnv });
  const added = JSON.parse(run('codex', ['plugin', 'add', 'voice-mcp@voice-mcp', '--json'], { env: hostEnv }));
  const pluginRoot = added.installedPath;
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.mcpServers), 'utf8')).mcpServers['voice-mcp'];
  await checkMcp({ label: 'Codex', command: mcp.command, args: mcp.args, cwd: path.resolve(pluginRoot, mcp.cwd ?? '.'), env: hostEnv, log });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.hooks), 'utf8'));
  await checkHook({
    host: 'codex',
    label: 'Codex',
    command: hooks.hooks.Stop[0].hooks[0].command.replaceAll('${PLUGIN_ROOT}', pluginRoot),
    cwd: elsewhere,
    env: { ...hostEnv, PLUGIN_ROOT: pluginRoot },
    log,
    expectStdout: '{}',
  });
});

await verify('agy', async ({ root, env, log }) => {
  const home = path.join(root, 'agy-home');
  fs.mkdirSync(home, { recursive: true });
  const hostEnv = { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
  run('agy', ['plugin', 'install', REPO], { env: hostEnv });
  const pluginRoot = path.join(home, '.gemini', 'config', 'plugins', 'voice-mcp');
  if (!fs.existsSync(path.join(pluginRoot, 'plugin.json'))) throw new Error(`not installed at ${pluginRoot}`);
  run('agy', ['plugin', 'validate', '--strict', pluginRoot], { env: hostEnv });
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp_config.json'), 'utf8')).mcpServers['voice-mcp'];
  const args = mcp.args.map((a) => a.replaceAll('${PLUGIN_ROOT}', pluginRoot));
  await checkMcp({ label: 'Antigravity', command: mcp.command, args, cwd: path.resolve(pluginRoot, mcp.cwd ?? '.'), env: { ...hostEnv, PLUGIN_ROOT: pluginRoot }, log });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  await checkHook({
    host: 'agy',
    label: 'Antigravity',
    command: hooks['voice-completion'].Stop[0].command,
    cwd: pluginRoot,
    env: { ...hostEnv, PLUGIN_ROOT: pluginRoot },
    log,
    expectStdout: '{"decision":"allow"}',
  });
});

for (const [host, outcome, detail] of results) {
  console.log(`${outcome.padEnd(8)} ${host}${detail ? `: ${detail}` : ''}`);
}
process.exitCode = results.some(([, outcome]) => outcome === 'FAILED') ? 1 : 0;
