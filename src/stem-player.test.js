import test from 'node:test';
import assert from 'node:assert/strict';
import { mixStemSamples, encodeMonoWav, StemPlayer } from './stem-player.js';
import { cropAudioSamples } from './audio-range.js';

function stems(guitar = [0.1, 0.2, -0.3, 0.4], drums = [0.4, -0.2, 0.1, 0.2]) {
  const channels = [Float32Array.from(guitar), Float32Array.from(drums)];
  return { numberOfChannels: 2, sampleRate: 2, duration: guitar.length / 2, getChannelData: i => channels[i] };
}

test('guitar, drums and both produce distinct mixes while TAB always reads the original guitar', () => {
  const audio = stems();
  const guitar = audio.getChannelData(0).slice();
  const drums = audio.getChannelData(1).slice();
  assert.deepEqual(mixStemSamples(audio, { guitar: true, drums: false }), guitar);
  assert.deepEqual(mixStemSamples(audio, { guitar: false, drums: true }), drums);
  const both = mixStemSamples(audio, { guitar: true, drums: true });
  both.forEach((sample, i) => assert.ok(Math.abs(sample - guitar[i] - drums[i]) < 1e-6));
  assert.equal(mixStemSamples(audio, { guitar: false, drums: false }), null);
  assert.deepEqual(cropAudioSamples(audio, { start: 0.5, end: 1.5 }).samples, guitar.slice(1, 3));
  assert.deepEqual(audio.getChannelData(0), guitar);
  assert.deepEqual(audio.getChannelData(1), drums);
});

test('combined playback prevents clipping with a single gain and WAV exports have one channel', () => {
  const audio = stems([0.8, -0.8, 0.2], [0.8, -0.8, 0.2]);
  const samples = mixStemSamples(audio, { guitar: true, drums: true });
  assert.ok(Math.abs(samples[0] - 0.98) < 1e-6);
  assert.ok(Math.abs(samples[1] + 0.98) < 1e-6);
  assert.ok(Math.abs(samples[2] / samples[0] - 0.25) < 1e-6);
  const wav = encodeMonoWav(samples, 22050);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.ok(Math.abs(view.getInt16(44, true) / 32767 - 0.98) < 1e-4);
});

class Media extends EventTarget {
  currentTime = 128;
  duration = 240;
  paused = true;
  readyState = 0;
  ended = false;
  playCount = 0;
  get src() { return this.source; }
  set src(value) { this.source = value; this.currentTime = 0; this.readyState = 0; }
  pause() { this.paused = true; }
  async play() { this.paused = false; this.playCount++; }
  metadata() { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
}

test('stem switches keep the song position and playback state, including rapid switches and no selection', async () => {
  const audio = new Media();
  const blobs = [];
  const revoked = [];
  const player = new StemPlayer(audio, { urls: {
    createObjectURL: blob => { blobs.push(blob); return `blob:stem-${blobs.length}`; },
    revokeObjectURL: url => revoked.push(url),
  } });
  player.load(stems());
  const guitar = player.select({ guitar: true, drums: false });
  audio.metadata();
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.paused, true);
  audio.currentTime = 1;
  await audio.play();
  const drums = player.select({ guitar: false, drums: true });
  const both = player.select({ guitar: true, drums: true });
  audio.metadata();
  assert.equal(audio.currentTime, 1);
  assert.equal(audio.paused, false);
  assert.equal(audio.playCount, 2);
  assert.notEqual(guitar.url, drums.url);
  assert.notEqual(drums.url, both.url);
  assert.equal(player.select({ guitar: false, drums: false }), null);
  assert.equal(audio.paused, true);
  assert.equal(player.select({ guitar: true, drums: false }).url, guitar.url);
  audio.metadata();
  assert.equal(audio.currentTime, 1);
  assert.equal(audio.paused, true);
  assert.equal(blobs.length, 3);
  assert.equal(blobs[0].type, 'audio/wav');
  assert.notDeepEqual(await blobs[0].arrayBuffer(), await blobs[1].arrayBuffer());
  player.clear();
  assert.equal(revoked.length, 3);
});
