import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePlayback, WINDOWS_FILE_SEPARATOR, WINDOWS_POWERSHELL } from '../src/audio/player.js';
import { which } from '../src/platform.js';
import { expandCommandArgs, writesOutputFile } from '../src/speech/providers/command.js';
import { buildKokoroArgs } from '../src/speech/providers/kokoro.js';
import { buildPiperArgs, defaultPython } from '../src/speech/providers/piper.js';
import { buildSystemInvocation, wpmToSapiRate } from '../src/speech/providers/system.js';
import { ProviderUnavailableError } from '../src/speech/providers/types.js';
import { parseEspeakVoices, parseSayVoices } from '../src/speech/voices.js';
import { piperDownloads, kokoroDownloads } from '../src/cli/models.js';

const none = () => null;
const all = (command: string) => `/usr/bin/${command}`;

describe('resolvePlayback', () => {
  it('uses afplay on macOS with player args before each file', () => {
    expect(resolvePlayback({ files: ['a.wav', 'b.wav'], settings: { player: null, playerArgs: ['-v', '0.5'] }, family: 'macos' })).toEqual([
      { command: 'afplay', args: ['-v', '0.5', 'a.wav'], label: 'afplay' },
      { command: 'afplay', args: ['-v', '0.5', 'b.wav'], label: 'afplay' },
    ]);
  });

  it('plays every file in one PowerShell process on Windows, passing paths through the environment', () => {
    const [only, ...rest] = resolvePlayback({
      files: ['C:\\a b\\chime.wav', 'C:\\x\\speech.wav'],
      settings: { player: null, playerArgs: [] },
      family: 'windows',
    });
    expect(rest).toEqual([]);
    expect(only!.command).toBe(WINDOWS_POWERSHELL);
    expect(only!.args).toContain('-NonInteractive');
    expect(only!.args.join(' ')).not.toContain('chime.wav');
    expect(only!.env).toEqual({ VOICE_MCP_AUDIO_FILES: `C:\\a b\\chime.wav${WINDOWS_FILE_SEPARATOR}C:\\x\\speech.wav` });
  });

  it('picks the first Linux player that is installed', () => {
    const find = (command: string) => (command === 'aplay' ? '/usr/bin/aplay' : null);
    expect(resolvePlayback({ files: ['a.wav'], settings: { player: null, playerArgs: [] }, family: 'linux', find })).toEqual([
      { command: 'aplay', args: ['-q', 'a.wav'], label: 'aplay' },
    ]);
    expect(resolvePlayback({ files: ['a.wav'], settings: { player: null, playerArgs: [] }, family: 'linux', find: none })).toEqual([]);
  });

  it('uses a configured player verbatim on every platform', () => {
    for (const family of ['macos', 'windows', 'linux'] as const) {
      expect(resolvePlayback({ files: ['a.wav'], settings: { player: 'mpv', playerArgs: ['--really-quiet'] }, family })).toEqual([
        { command: 'mpv', args: ['--really-quiet', 'a.wav'], label: 'mpv' },
      ]);
    }
  });
});

describe('system voice invocation', () => {
  const base = { textFile: path.join('w', 'in.txt'), workDir: 'w', find: all };

  it('uses say on macOS with voice and rate flags', () => {
    expect(buildSystemInvocation({ ...base, family: 'macos', voice: 'Samantha', rate: 200 })).toEqual({
      command: 'say',
      args: ['-f', base.textFile, '-o', path.join('w', 'system.aiff'), '-v', 'Samantha', '-r', '200'],
      outFile: path.join('w', 'system.aiff'),
    });
  });

  it('renders a WAV with SAPI on Windows and passes inputs through the environment', () => {
    const invocation = buildSystemInvocation({ ...base, family: 'windows', voice: 'Microsoft Zira Desktop', rate: 211 });
    expect(invocation.command).toBe(WINDOWS_POWERSHELL);
    expect(invocation.outFile).toBe(path.join('w', 'system.wav'));
    expect(invocation.env).toEqual({
      VOICE_MCP_TEXT_FILE: base.textFile,
      VOICE_MCP_OUT_FILE: path.join('w', 'system.wav'),
      VOICE_MCP_VOICE: 'Microsoft Zira Desktop',
      VOICE_MCP_RATE: '2',
    });
    expect(invocation.args.join(' ')).toContain('SetOutputToWaveFile');
  });

  it('uses espeak-ng on Linux and reports when it is missing', () => {
    expect(buildSystemInvocation({ ...base, family: 'linux', voice: 'en-us', rate: null }).command).toBe('espeak-ng');
    expect(() => buildSystemInvocation({ ...base, family: 'linux', voice: null, rate: null, find: none })).toThrow(ProviderUnavailableError);
  });

  it('maps words per minute onto the SAPI -10..10 scale', () => {
    expect(wpmToSapiRate(175)).toBe(0);
    expect(wpmToSapiRate(50)).toBe(-7);
    expect(wpmToSapiRate(600)).toBe(10);
  });
});

describe('Kokoro, Piper, and command providers', () => {
  it('builds Kokoro arguments', () => {
    expect(
      buildKokoroArgs({ textFile: 't', outFile: 'o', modelPath: 'm', voicesPath: 'v', voice: 'af_bella', lang: 'en-us', speed: 1 })
    ).toEqual(['t', 'o', '--format', 'wav', '--lang', 'en-us', '--voice', 'af_bella', '--model', 'm', '--voices', 'v', '--speed', '1.00']);
  });

  it('ends Piper option parsing before the text so a leading dash stays text', () => {
    const args = buildPiperArgs({ dataDir: 'd', model: 'en_US-joe-medium', outFile: 'o.wav', text: '-v is not a flag' });
    expect(args.slice(-2)).toEqual(['--', '-v is not a flag']);
  });

  it('picks a Python name that exists on each platform', () => {
    expect(defaultPython('windows')).toBe('python');
    expect(defaultPython('macos')).toBe('python3');
  });

  it('expands command placeholders and detects file output', () => {
    const args = ['--in', '{textFile}', '--out', '{outFile}', '--voice={voice}', '{text}'];
    expect(writesOutputFile(args)).toBe(true);
    expect(writesOutputFile(['{text}'])).toBe(false);
    expect(expandCommandArgs(args, { text: 'hi {outFile}', textFile: 't.txt', outFile: 'o.wav', voice: 'v1' })).toEqual([
      '--in',
      't.txt',
      '--out',
      'o.wav',
      '--voice=v1',
      'hi {outFile}',
    ]);
  });
});

describe('voice listing parsers', () => {
  it('parses say -v ? output, including names with spaces', () => {
    const output = [
      'Albert              en_US    # Hello! My name is Albert.',
      'Bad News            en_US    # Hello! My name is Bad News.',
      'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
      '',
    ].join('\n');
    expect(parseSayVoices(output).map((voice) => voice.id)).toEqual(['Albert', 'Bad News', 'Eddy (English (UK))']);
  });

  it('parses espeak-ng --voices output', () => {
    const output = 'Pty Language       Age/Gender VoiceName          File                 Other Languages\n 5  af              --/M      Afrikaans          gmw/af\n 5  en-us           --/M      English_(America)  gmw/en-US\n';
    expect(parseEspeakVoices(output)).toEqual([
      { id: 'af', label: 'Afrikaans', group: 'af' },
      { id: 'en-us', label: 'English (America)', group: 'en' },
    ]);
  });
});

describe('model downloads', () => {
  it('maps a Piper voice name onto its Hugging Face path', () => {
    const [onnx, json] = piperDownloads('/models/piper', 'en_US-joe-medium');
    expect(onnx!.url).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/joe/medium/en_US-joe-medium.onnx?download=true');
    expect(json!.file).toBe(path.join('/models/piper', 'en_US-joe-medium.onnx.json'));
    expect(() => piperDownloads('/m', '../../etc/passwd')).toThrow(/Invalid Piper voice/);
  });

  it('downloads both Kokoro files into the kokoro folder', () => {
    expect(kokoroDownloads('/models').map((d) => d.file)).toEqual([
      path.join('/models', 'kokoro', 'kokoro-v1.0.onnx'),
      path.join('/models', 'kokoro', 'voices-v1.0.bin'),
    ]);
  });
});

describe('which on Windows', () => {
  it('only returns files that can be spawned without a shell', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-which-'));
    try {
      fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh');
      fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
      fs.writeFileSync(path.join(dir, 'shim.cmd'), '@echo off');
      fs.writeFileSync(path.join(dir, 'tool.exe'), 'MZ');
      fs.writeFileSync(path.join(dir, 'python3.11.exe'), 'MZ');
      const env = { PATH: dir };
      expect(which('tool', { env, platform: 'win32' })).toBe(path.join(dir, 'tool.exe'));
      expect(which('shim', { env, platform: 'win32' })).toBeNull();
      expect(which('shim.cmd', { env, platform: 'win32' })).toBeNull();
      expect(which('python3.11', { env, platform: 'win32' })).toBe(path.join(dir, 'python3.11.exe'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('which', () => {
  it('finds node on PATH and rejects unknown commands', () => {
    expect(which('node')).not.toBeNull();
    expect(which('definitely-not-a-real-command-xyz')).toBeNull();
    expect(which(process.execPath)).toBe(path.resolve(process.execPath));
  });
});
