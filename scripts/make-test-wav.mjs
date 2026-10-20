// Generate a test WAV with a known melody so the transcription pipeline can be
// verified end-to-end. Written to public/ so the dev server serves it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const NOTE_SEC = 0.5;
// E4 G4 A4 B4 A4 G4 E4 D4 — MIDI pitches
const MELODY = [64, 67, 69, 71, 69, 67, 64, 62];

const total = Math.ceil(MELODY.length * NOTE_SEC * SAMPLE_RATE);
const samples = new Float32Array(total);

MELODY.forEach((midi, i) => {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const start = Math.floor(i * NOTE_SEC * SAMPLE_RATE);
  const len = Math.floor(NOTE_SEC * SAMPLE_RATE * 0.9);
  for (let n = 0; n < len; n++) {
    const t = n / SAMPLE_RATE;
    const env = Math.min(1, n / 300) * Math.exp(-2.2 * t);
    // Fundamental + a couple of harmonics so it resembles a plucked string.
    const v =
      Math.sin(2 * Math.PI * freq * t) * 0.6 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * freq * 3 * t) * 0.1;
    samples[start + n] += v * env * 0.5;
  }
});

const pcm = new Int16Array(total);
for (let i = 0; i < total; i++) {
  pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
}

const dataSize = pcm.length * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);
Buffer.from(pcm.buffer).copy(buf, 44);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'test-melody.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log('Wrote', out, `(${MELODY.length} notes: E4 G4 A4 B4 A4 G4 E4 D4)`);
