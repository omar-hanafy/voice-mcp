import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { brokerEndpointFor, expandHome, resolveModelsDir, resolvePaths } from '../src/config/paths.js';

const home = path.resolve('/home/tester');
const temp = path.resolve('/tmp');

describe('resolvePaths', () => {
  it('uses the platform application-data folder by default', () => {
    expect(resolvePaths({ platform: 'darwin', env: {}, homeDir: home, tempDir: temp, pluginRoot: '/p' }).dataDir).toBe(
      path.join(home, 'Library', 'Application Support', 'voice-mcp')
    );
    expect(
      resolvePaths({ platform: 'win32', env: { APPDATA: path.join(home, 'Roaming') }, homeDir: home, tempDir: temp, pluginRoot: '/p' })
        .dataDir
    ).toBe(path.join(home, 'Roaming', 'voice-mcp'));
    expect(resolvePaths({ platform: 'win32', env: {}, homeDir: home, tempDir: temp, pluginRoot: '/p' }).dataDir).toBe(
      path.join(home, 'AppData', 'Roaming', 'voice-mcp')
    );
    expect(resolvePaths({ platform: 'linux', env: {}, homeDir: home, tempDir: temp, pluginRoot: '/p' }).dataDir).toBe(
      path.join(home, '.config', 'voice-mcp')
    );
    expect(
      resolvePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, homeDir: home, tempDir: temp, pluginRoot: '/p' })
        .dataDir
    ).toBe(path.join(home, 'xdg', 'voice-mcp'));
  });

  it('honors VOICE_MCP_HOME, including a leading ~', () => {
    const paths = resolvePaths({ platform: 'darwin', env: { VOICE_MCP_HOME: '~/voice' }, homeDir: home, tempDir: temp, pluginRoot: '/p' });
    expect(paths.dataDir).toBe(path.join(home, 'voice'));
    expect(paths.settingsPath).toBe(path.join(home, 'voice', 'settings.jsonc'));
    expect(paths.defaultModelsDir).toBe(path.join(home, 'voice', 'models'));
  });

  it('keeps temp space private to the data directory', () => {
    const a = resolvePaths({ platform: 'linux', env: { VOICE_MCP_HOME: '/a' }, homeDir: home, tempDir: temp, pluginRoot: '/p' });
    const b = resolvePaths({ platform: 'linux', env: { VOICE_MCP_HOME: '/b' }, homeDir: home, tempDir: temp, pluginRoot: '/p' });
    expect(a.tempDir).not.toBe(b.tempDir);
    expect(path.dirname(a.tempDir)).toBe(temp);
  });

  it('keeps Linux temp files in the private runtime directory when available', () => {
    const paths = resolvePaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, homeDir: home, pluginRoot: '/p' });
    expect(path.dirname(paths.tempDir)).toBe(path.resolve('/run/user/1000'));
  });

  it('locates the bundled chime under the plugin root', () => {
    const paths = resolvePaths({ env: {}, homeDir: home, tempDir: temp, pluginRoot: '/plugin' });
    expect(paths.defaultChimePath).toBe(path.join(path.resolve('/plugin'), 'assets', 'chime.wav'));
  });

  it('finds the real plugin root when not overridden', () => {
    const paths = resolvePaths({ env: {}, homeDir: home, tempDir: temp });
    expect(paths.defaultChimePath.endsWith(path.join('plugin', 'assets', 'chime.wav'))).toBe(true);
  });
});

describe('broker endpoint', () => {
  it('uses a per-data-directory named pipe on Windows, ignoring path case', () => {
    const a = brokerEndpointFor({ family: 'windows', dataDir: 'C:\\Users\\Me\\AppData\\Roaming\\voice-mcp', tempDir: 'C:\\Temp' });
    const b = brokerEndpointFor({ family: 'windows', dataDir: 'c:\\users\\me\\appdata\\roaming\\voice-mcp', tempDir: 'C:\\Temp' });
    expect(a).toMatch(/^\\\\\.\\pipe\\voice-mcp-[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });

  it('uses a socket in the data directory when the path is short enough', () => {
    expect(brokerEndpointFor({ family: 'macos', dataDir: '/Users/me/voice', tempDir: '/tmp' })).toBe(
      path.join('/Users/me/voice', 'broker.sock')
    );
  });

  it('falls back to a hashed temp socket when the path would exceed the Unix limit', () => {
    const longDir = `/Users/me/${'very-long-folder-name/'.repeat(6)}voice-mcp`;
    const endpoint = brokerEndpointFor({ family: 'macos', dataDir: longDir, tempDir: '/tmp' });
    expect(endpoint).toMatch(/voice-mcp-[0-9a-f]{12}\.sock$/);
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
  });
});

describe('models directory', () => {
  const paths = resolvePaths({ env: { VOICE_MCP_HOME: '/data' }, homeDir: home, tempDir: temp, pluginRoot: '/p' });

  it('prefers the environment, then settings, then the default', () => {
    expect(resolveModelsDir({ paths, configured: '~/models', env: { VOICE_MCP_MODELS_DIR: '/env/models' }, homeDir: home })).toBe(
      path.resolve('/env/models')
    );
    expect(resolveModelsDir({ paths, configured: '~/models', env: {}, homeDir: home })).toBe(path.join(home, 'models'));
    expect(resolveModelsDir({ paths, configured: null, env: {}, homeDir: home })).toBe(paths.defaultModelsDir);
  });

  it('expands ~ with either separator', () => {
    expect(expandHome('~/a', home)).toBe(path.join(home, 'a'));
    expect(expandHome('~\\a', home)).toBe(path.join(home, 'a'));
    expect(expandHome('/abs', home)).toBe('/abs');
  });
});

describe.skipIf(process.platform === 'win32')('ensurePrivateDir', () => {
  it('refuses a directory other users can reach', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { ensurePrivateDir } = await import('../src/util/fs.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-private-'));
    try {
      const open = path.join(root, 'open');
      fs.mkdirSync(open, { mode: 0o777 });
      fs.chmodSync(open, 0o777);
      await expect(ensurePrivateDir(open)).rejects.toThrow(/Refusing/);
      await expect(ensurePrivateDir(path.join(root, 'fresh'))).resolves.toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
