import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MIN_NODE_MAJOR } from '../src/version.js';
import { REPO_ROOT } from './helpers.js';

const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json')) as { engines: { node: string }; devDependencies: Record<string, string> };

describe('supported Node.js versions stay in one place', () => {
  it('package.json engines match the minimum doctor checks', () => {
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });

  it('Node.js types describe the oldest supported Node.js, so newer APIs fail to typecheck', () => {
    expect(/^\^?(\d+)\./.exec(pkg.devDependencies['@types/node']!)?.[1]).toBe(String(MIN_NODE_MAJOR));
  });

  it('CI tests the oldest supported Node.js on every OS', () => {
    const matrix = /node: \[([^\]]+)\]/.exec(read('.github/workflows/ci.yml'))?.[1];
    expect(matrix?.split(',').map((v) => Number(v.trim()))).toContain(MIN_NODE_MAJOR);
  });

  it('README states the same minimum', () => {
    expect(read('README.md')).toContain(`Node.js ${MIN_NODE_MAJOR} or newer`);
  });
});
