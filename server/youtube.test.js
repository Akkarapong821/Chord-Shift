import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createYouTubeHandler, extractVideoId } from './youtube.js';
import { downloadAudio } from './youtube-download.js';

const fixture = Buffer.from('0000ftypM4A audio fixture');
const videoUrl = 'https://www.youtube.com/watch?v=z164pDlYtOk&list=RDz164pDlYtOk&start_radio=1';
const info = { basic_info: { title: 'สุขสันต์วันเลิกรา', duration: 281 }, playability_status: { status: 'OK' } };
async function request(t, options = {}, url = videoUrl, suffix = '') {
  const server = createServer(createYouTubeHandler({
    getInnertube: async () => ({ getBasicInfo: async () => info }),
    download: async () => fixture,
    ...options,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return fetch(`http://127.0.0.1:${server.address().port}/?url=${encodeURIComponent(url)}${suffix}`);
}

test('guitar mode separates the chosen clip and preserves its source timestamp', async (t) => {
  const guitar = Buffer.from('RIFF0000WAVEguitar');
  const response = await request(t, { separate: async (audio, range, signal) => {
    assert.deepEqual(audio, fixture);
    assert.deepEqual(range, { start: 85, end: 90 });
    assert.equal(signal.aborted, false);
    return guitar;
  } }, videoUrl, '&isolate=guitar&start=85&end=90');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('x-audio-start'), '85');
  assert.equal(response.headers.get('x-audio-isolation'), 'guitar');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), guitar);
});

test('guitar mode rejects missing or excessive ranges before downloading', async (t) => {
  for (const range of ['', '&start=-1&end=10', '&start=85&end=84', '&start=0&end=61', '&start=NaN&end=5']) {
    const response = await request(t, { download: () => assert.fail('must not download') }, videoUrl, `&isolate=guitar${range}`);
    assert.equal(response.status, 422);
    assert.equal(await response.text(), 'guitar-range-invalid');
  }
});

test('whole-song guitar listening returns the full stem independently of the TAB interval', async (t) => {
  const wave = Buffer.from('RIFF0000WAVEwhole-song-guitar');
  const response = await request(t, { separate: async (_audio, range) => {
    assert.deepEqual(range, { start: 0, end: null, full: true }); return wave;
  } }, videoUrl, '&isolate=guitar&full=1&start=196&end=211');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-audio-start'), '0');
  assert.equal(response.headers.get('x-audio-full-song'), '1');
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave);
});

test('failed separation never silently substitutes the full mix', async (t) => {
  const response = await request(t, { separate: async () => { throw Object.assign(new Error('missing'), { code: 'guitar-not-installed', status: 503 }); } }, videoUrl, '&isolate=guitar&start=85&end=90');
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.equal(await response.text(), 'guitar-not-installed');
});

test('aligned guitar and drum stems are returned together and invalid selections never download', async (t) => {
  const wave = Buffer.from('RIFF0000WAVEguitar-and-drums');
  const response = await request(t, { separate: async (_audio, range) => {
    assert.deepEqual(range, { start: 0, end: null, full: true, stems: ['guitar', 'drums'] });
    return wave;
  } }, videoUrl, '&isolate=guitar&full=1&stems=guitar,drums');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-audio-stems'), 'guitar,drums');
  assert.equal(response.headers.get('x-audio-isolation'), 'guitar');
  assert.equal(response.headers.get('x-audio-full-song'), '1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave);
  const invalid = await request(t, { download: () => assert.fail('must not download') }, videoUrl, '&isolate=guitar&full=1&stems=vocals');
  assert.equal(invalid.status, 422);
  assert.equal(await invalid.text(), 'guitar-stems-invalid');
});

test('YouTube URLs select one video and reject lookalike domains', () => {
  assert.equal(extractVideoId(videoUrl), 'z164pDlYtOk');
  assert.equal(extractVideoId('https://youtu.be/z164pDlYtOk?t=30'), 'z164pDlYtOk');
  assert.equal(extractVideoId('https://youtube.com/shorts/z164pDlYtOk'), 'z164pDlYtOk');
  for (const url of ['https://youtube.com.evil.test/watch?v=z164pDlYtOk', 'file://youtube.com/watch?v=z164pDlYtOk', 'bad', 'https://youtube.com/shorts/z164pDlYtOkEXTRA']) {
    assert.equal(extractVideoId(url), null);
  }
});

test('successful endpoint returns complete audio with Thai title and actual byte count', async (t) => {
  const response = await request(t, { download: async (id) => { assert.equal(id, 'z164pDlYtOk'); return fixture; } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mp4');
  assert.equal(Number(response.headers.get('content-length')), fixture.length);
  assert.equal(decodeURIComponent(response.headers.get('x-video-title')), info.basic_info.title);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
});

test('download is attempted when YouTube metadata reports login required', async (t) => {
  let downloaded = false;
  const response = await request(t, {
    getInnertube: async () => ({ getBasicInfo: async () => ({
      ...info,
      playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in required' },
    }) }),
    download: async () => { downloaded = true; return fixture; },
  });
  assert.equal(downloaded, true);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
});

test('fallback preserves explicit downloader errors', async (t) => {
  const response = await request(t, {
    getInnertube: async () => ({ getBasicInfo: async () => ({
      ...info,
      playability_status: { status: 'LOGIN_REQUIRED' },
    }) }),
    download: async () => { throw Object.assign(new Error('too long'), { code: 'video-too-long', status: 413 }); },
  });
  assert.equal(response.status, 413);
  assert.equal(await response.text(), 'video-too-long');
});

test('metadata lookup failure falls back to download and uses the video ID as title', async (t) => {
  const response = await request(t, {
    getInnertube: async () => { throw new Error('metadata unavailable'); },
    download: async () => fixture,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-video-title'), 'z164pDlYtOk');
});

test('invalid URL never starts downloading', async (t) => {
  const response = await request(t, { download: () => assert.fail('must not download') }, 'not-youtube');
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'invalid-url');
});

test('videos over 15 minutes and live streams are rejected before download', async (t) => {
  for (const [basic, code, status] of [[{ duration: 901 }, 'video-too-long', 413], [{ is_live: true }, 'live-video', 400]]) {
    const response = await request(t, {
      getInnertube: async () => ({ getBasicInfo: async () => ({ ...info, basic_info: { ...info.basic_info, ...basic } }) }),
      download: () => assert.fail('must not download'),
    });
    assert.equal(response.status, status);
    assert.equal(await response.text(), code);
  }
});

test('download failure returns readable error without stale audio length or broken connection', async (t) => {
  const response = await request(t, { download: async () => { throw Object.assign(new Error('403'), { code: 'upstream-forbidden', status: 502 }); } });
  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(response.headers.get('x-video-title'), null);
  assert.equal(await response.text(), 'upstream-forbidden');
});

test('YouTube bot-check responses use a distinct actionable error', async (t) => {
  const response = await request(t, {
    download: async () => { throw Object.assign(new Error('blocked'), { code: 'youtube-bot-check', status: 502 }); },
  });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'youtube-bot-check');
});

test('empty download is rejected', async (t) => {
  const response = await request(t, { download: async () => Buffer.alloc(0) });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'incomplete-audio');
});

test('timeout aborts downloader and returns an actionable HTTP error', async (t) => {
  const response = await request(t, {
    timeoutMs: 20,
    download: (_id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })),
  });
  assert.equal(response.status, 504);
  assert.equal(await response.text(), 'download-timeout');
});

test('timeout also bounds stalled YouTube metadata requests', async (t) => {
  const response = await request(t, { timeoutMs: 20, getInnertube: () => new Promise(() => {}) });
  assert.equal(response.status, 504);
  assert.equal(await response.text(), 'download-timeout');
});

function fakeSpawn(run) {
  return (_binary, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=z164pDlYtOk');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 1));
    queueMicrotask(() => run(child));
    return child;
  };
}

test('downloader accepts successful M4A and discards partial bytes on failure', async () => {
  const signal = new AbortController().signal;
  const audio = await downloadAudio('z164pDlYtOk', signal, { spawnProcess: fakeSpawn((child) => {
    child.stdout.write(fixture); child.emit('close', 0);
  }) });
  assert.deepEqual(audio, fixture);
  await assert.rejects(downloadAudio('z164pDlYtOk', signal, { spawnProcess: fakeSpawn((child) => {
    child.stdout.write(fixture); child.stderr.write('ERROR: HTTP 403 Forbidden'); child.emit('close', 1);
  }) }), { code: 'upstream-forbidden' });
});

test('missing downloader and non-audio output produce explicit errors', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(downloadAudio('z164pDlYtOk', signal, { spawnProcess: fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })); child.emit('close', -2);
  }) }), { code: 'downloader-missing' });
  await assert.rejects(downloadAudio('z164pDlYtOk', signal, { spawnProcess: fakeSpawn((child) => {
    child.stdout.write('this is not an audio file'); child.emit('close', 0);
  }) }), { code: 'invalid-audio' });
  await assert.rejects(downloadAudio('z164pDlYtOk', signal, { spawnProcess: fakeSpawn((child) => {
    child.stderr.write("ERROR: Sign in to confirm you're not a bot"); child.emit('close', 1);
  }) }), { code: 'youtube-bot-check', status: 502 });
});
