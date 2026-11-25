#!/usr/bin/env node
// Synthesizes plugin/assets/chime.wav: a soft two-note bell, 16-bit PCM mono.
// Generated rather than sampled so the asset is reproducible and free of licensing questions.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44_100;
const DURATION_S = 0.7;
const notes = [
  // [frequency Hz, start s, peak amplitude, decay rate]
  [880.0, 0.0, 0.32, 7.0], // A5
  [1318.5, 0.11, 0.26, 6.0], // E6
];

const total = Math.round(SAMPLE_RATE * DURATION_S);
const samples = new Int16Array(total);
for (let i = 0; i < total; i += 1) {
  const t = i / SAMPLE_RATE;
  let value = 0;
  for (const [freq, start, amp, decay] of notes) {
    if (t < start) continue;
    const local = t - start;
    const attack = Math.min(1, local / 0.006); // 6 ms attack avoids a click
    const envelope = attack * Math.exp(-decay * local);
    // A quiet octave partial gives the bell some body.
    value += amp * envelope * (Math.sin(2 * Math.PI * freq * local) + 0.18 * Math.sin(4 * Math.PI * freq * local));
  }
  const fadeOut = Math.min(1, (DURATION_S - t) / 0.05);
  samples[i] = Math.round(Math.max(-1, Math.min(1, value * fadeOut)) * 32_767);
}

const dataBytes = samples.length * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(dataBytes, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'assets', 'chime.wav');
writeFileSync(out, Buffer.concat([header, Buffer.from(samples.buffer)]));
console.log(`wrote ${out} (${header.length + dataBytes} bytes)`);
