#!/usr/bin/env node
// Fails when the committed bundle or plugin manifests disagree with the sources.
// Run after `npm run build` (CI does): the bundle must be rebuilt and committed with src/ changes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const problems = [];

const { version } = read('package.json');
for (const manifest of ['plugin/.claude-plugin/plugin.json', 'plugin/.codex-plugin/plugin.json', 'plugin/plugin.json']) {
  const found = read(manifest).version;
  if (found !== version) problems.push(`${manifest} has version ${found}; package.json has ${version}`);
}
const swiftbar = /<swiftbar\.version>([^<]+)<\/swiftbar\.version>/.exec(
  readFileSync(join(root, 'integrations/swiftbar/voice-mcp.5s.js'), 'utf8')
)?.[1];
if (swiftbar !== version) problems.push(`integrations/swiftbar/voice-mcp.5s.js has version ${swiftbar}; package.json has ${version}`);
if (!readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## ${version}`)) {
  problems.push(`CHANGELOG.md has no "## ${version}" section`);
}

const status = execFileSync('git', ['status', '--porcelain', '--', 'plugin/dist'], { cwd: root, encoding: 'utf8' }).trim();
if (status) problems.push(`plugin/dist is out of date with src/ (rebuild and commit it):\n${status}`);

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: bundle, manifests, and changelog agree on ${version}`);
