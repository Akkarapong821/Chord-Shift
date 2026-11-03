import test from 'node:test';
import assert from 'node:assert/strict';
import { startTabRecording, canRecordTab } from './tab-recording.js';

class Track extends EventTarget {
  stopped = false;
  constructor(kind, surface = 'browser') { super(); this.kind = kind; this.surface = surface; }
  stop() { this.stopped = true; }
  getSettings() { return { displaySurface: this.surface }; }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
class Recorder extends EventTarget {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio bytes']) }));
      this.dispatchEvent(new Event('stop'));
    });
  }
}
const make = (tracks = [new Track('video'), new Track('audio')], extra = {}) => {
  const shared = new Stream(tracks);
  let recorder;
  class CapturingRecorder extends Recorder { constructor(...args) { super(...args); recorder = this; } }
  return {
    tracks,
    get recorder() { return recorder; },
    options: { getDisplayMedia: async () => shared, Recorder: CapturingRecorder, Stream, ...extra },
  };
};

test('only audio is recorded and every shared track is released on stop', async () => {
  const fixture = make();
  const session = await startTabRecording(fixture.options);
  assert.deepEqual(fixture.recorder.stream.getTracks().map(t => t.kind), ['audio']);
  session.stop(); session.stop();
  const audio = await session.finished;
  assert.equal(await audio.text(), 'audio bytes');
  assert.equal(audio.type, 'audio/webm;codecs=opus');
  assert.ok(fixture.tracks.every(t => t.stopped));
});

test('cancel discards audio and ending the browser share finalizes recording', async () => {
  const fixture = make();
  const session = await startTabRecording(fixture.options);
  session.cancel();
  assert.equal(await session.finished, null);
  assert.ok(fixture.tracks.every(t => t.stopped));
  const other = make();
  const recording = await startTabRecording(other.options);
  other.tracks[0].dispatchEvent(new Event('ended'));
  assert.ok((await recording.finished).size > 0);
  assert.ok(other.tracks.every(t => t.stopped));
});

test('missing audio and non-tab selections are rejected and cleaned up', async () => {
  for (const tracks of [[new Track('video')], [new Track('video', 'monitor'), new Track('audio')]]) {
    const fixture = make(tracks);
    await assert.rejects(startTabRecording(fixture.options), /แชร์.*แท็บ/);
    assert.ok(tracks.every(t => t.stopped));
  }
});

test('size limit rejects oversized recordings and time limit stops recording', async () => {
  const fixture = make(undefined, { maxBytes: 1 });
  const session = await startTabRecording(fixture.options);
  session.stop();
  await assert.rejects(session.finished, /เกิน 32 MB/);
  assert.ok(fixture.tracks.every(t => t.stopped));
  const timed = make(undefined, { maxDurationMs: 10 });
  const automatic = await startTabRecording(timed.options);
  assert.ok((await automatic.finished).size > 0);
  assert.ok(timed.tracks.every(t => t.stopped));
});

test('recorder initialization errors release sharing and unsupported browsers are detected', async () => {
  const fixture = make(undefined, { Recorder: class { static isTypeSupported() { throw new Error('encoder failed'); } } });
  await assert.rejects(startTabRecording(fixture.options), /encoder failed/);
  assert.ok(fixture.tracks.every(t => t.stopped));
  assert.equal(canRecordTab({}), false);
  assert.equal(canRecordTab({ navigator: { mediaDevices: { getDisplayMedia() {} } }, MediaRecorder: Recorder, MediaStream: Stream }), true);
});
