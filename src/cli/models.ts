import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { KOKORO_MODEL_FILE, KOKORO_VOICES_FILE } from '../speech/providers/kokoro.js';

const KOKORO_RELEASE = 'https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0';
const PIPER_VOICES = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';

export interface Download {
  url: string;
  file: string;
}

export function kokoroDownloads(modelsDir: string): Download[] {
  const dir = path.join(modelsDir, 'kokoro');
  return [KOKORO_MODEL_FILE, KOKORO_VOICES_FILE].map((name) => ({
    url: `${KOKORO_RELEASE}/${name}`,
    file: path.join(dir, name),
  }));
}

/** Piper voice ids look like en_US-joe-medium: <lang>_<REGION>-<speaker>-<quality>. */
export function piperDownloads(dataDir: string, voice: string): Download[] {
  const match = /^([a-z]{2,3})_([A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$/.exec(voice);
  if (!match) {
    throw new Error(`Invalid Piper voice "${voice}". Expected a name like en_US-joe-medium.`);
  }
  const [, family, region, speaker, quality] = match;
  const base = `${PIPER_VOICES}/${family}/${family}_${region}/${speaker}/${quality}/${voice}`;
  return ['.onnx', '.onnx.json'].map((ext) => ({
    url: `${base}${ext}?download=true`,
    file: path.join(dataDir, `${voice}${ext}`),
  }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Download each file unless it already exists. Writes to a temp file and renames on success. */
export async function downloadAll(downloads: Download[], log: (line: string) => void): Promise<void> {
  for (const { url, file } of downloads) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      log(`already present: ${file}`);
      continue;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.partial`;
    log(`downloading ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
    }
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastReported = 0;
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (total > 0 && received - lastReported >= total / 10) {
        lastReported = received;
        log(`  ${Math.round((received / total) * 100)}% of ${formatBytes(total)}`);
      }
    });
    try {
      await pipeline(source, fs.createWriteStream(partial));
      await fsp.rename(partial, file);
    } catch (error) {
      await fsp.rm(partial, { force: true });
      throw error;
    }
    log(`saved ${file} (${formatBytes(received)})`);
  }
}
