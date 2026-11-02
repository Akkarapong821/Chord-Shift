import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioTime, readAudioRange, formatAudioTime, cropAudioSamples, notesInOriginalTime } from './audio-range.js';

test('timestamps accept minutes:seconds, raw seconds and decimals', () => {
  assert.equal(parseAudioTime(' 1:25 '), 85);
  assert.equal(parseAudioTime('85.25'), 85.25);
  assert.equal(parseAudioTime('1:05.25'), 65.25);
  assert.deepEqual(readAudioRange('', '', 281.472), { start: 0, end: 281.472 });
  assert.deepEqual(readAudioRange('1:25', ''), { start: 85, end: Infinity });
  assert.deepEqual(readAudioRange('1:25', '1:50', 281), { start: 85, end: 110 });
});

test('invalid, reversed, zero length and out-of-bounds selections are rejected', () => {
  for (const text of ['-1', '1:60', '1:234', 'abc', '1e3', 'Infinity', '1:00:00']) {
    assert.throws(() => parseAudioTime(text));
  }
  for (const [start, end] of [['2', '1'], ['2', '2'], ['0', '0.01'], ['4', ''], ['0', '4.1']]) {
    assert.throws(() => readAudioRange(start, end, 4));
  }
});

test('display timestamps round-trip without exceeding the source duration', () => {
  assert.equal(formatAudioTime(0), '0:00');
  assert.equal(formatAudioTime(10), '0:10');
  assert.equal(formatAudioTime(65.25), '1:05.25');
  assert.equal(formatAudioTime(600), '10:00');
  assert.equal(formatAudioTime(59.9999), '0:59.999');
  const duration = 281.47238;
  assert.ok(readAudioRange('0', formatAudioTime(duration), duration).end <= duration);
});

test('only selected samples reach transcription and the cached source remains intact', () => {
  const source = Float32Array.from({ length: 40 }, (_, i) => i);
  const audio = { sampleRate: 10, getChannelData: () => source };
  const selection = cropAudioSamples(audio, { start: 1, end: 2.5 });
  assert.deepEqual([...selection.samples], Array.from({ length: 15 }, (_, i) => i + 10));
  assert.equal(selection.start, 1);
  assert.equal(selection.end, 2.5);
  selection.samples[0] = -1;
  assert.equal(source[10], 10);
  assert.equal(cropAudioSamples(audio, { start: 0, end: 4 }).samples.length, 40);
});

test('notes use original song time and do not leak across the selection boundaries', () => {
  const notes = [
    { startTimeSeconds: -0.1, durationSeconds: 0.3, pitchMidi: 64 },
    { startTimeSeconds: 1, durationSeconds: 0.5, pitchMidi: 67 },
    { startTimeSeconds: 1.9, durationSeconds: 1, pitchMidi: 69 },
    { startTimeSeconds: 2, durationSeconds: 0.5, pitchMidi: 71 },
    { startTimeSeconds: -1, durationSeconds: 0.5, pitchMidi: 40 },
  ];
  const original = structuredClone(notes);
  const result = notesInOriginalTime(notes, { start: 85, end: 87 });
  assert.deepEqual(result.map(n => n.startTimeSeconds), [85, 86, 86.9]);
  assert.deepEqual(result.map(n => n.pitchMidi), [64, 67, 69]);
  assert.ok(result.every(n => n.startTimeSeconds >= 85 && n.startTimeSeconds + n.durationSeconds <= 87));
  assert.deepEqual(notes, original);
});
