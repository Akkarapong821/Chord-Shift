import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultYouTubeSource, youtubeRequestUrl, checkYouTubeHelper, youtubePreviewUrl, checkLocalServer, LOCAL_SERVER_URL } from './youtube-source.js';

test('YouTube preview plays the selected interval with an absolute stop time', () => {
  const preview = new URL(youtubePreviewUrl('https://youtu.be/z164pDlYtOk?t=5', { start: 85, end: 95 }));
  assert.equal(preview.origin, 'https://www.youtube-nocookie.com');
  assert.equal(preview.pathname, '/embed/z164pDlYtOk');
  assert.equal(preview.searchParams.get('start'), '85');
  assert.equal(preview.searchParams.get('end'), '95');
  assert.equal(preview.searchParams.get('playsinline'), '1');
  const whole = new URL(youtubePreviewUrl('https://youtube.com/watch?v=z164pDlYtOk&list=abc', { start: 0, end: Infinity }));
  assert.equal(whole.searchParams.has('end'), false);
  for (const url of ['https://youtube.com.evil.test/watch?v=z164pDlYtOk', 'javascript:alert(1)', 'invalid']) {
    assert.throws(() => youtubePreviewUrl(url, { start: 0, end: 10 }));
  }
});

test('hosted pages use the home server while local pages use their own API', () => {
  assert.equal(defaultYouTubeSource('chord-shift.onrender.com'), 'home');
  assert.equal(defaultYouTubeSource('akkarapong821.github.io'), 'home');
  assert.equal(defaultYouTubeSource('127.0.0.1'), 'server');
  assert.equal(defaultYouTubeSource('localhost'), 'server');
  const video = 'https://youtube.com/watch?v=z164pDlYtOk&list=test';
  const url = new URL(youtubeRequestUrl(video, 'helper'));
  assert.equal(url.origin, 'http://127.0.0.1:39841');
  assert.equal(url.searchParams.get('url'), video);
  assert.ok(youtubeRequestUrl(video, 'server').startsWith('/api/youtube?'));
});

test('online pages find the server on this computer automatically without a configured URL', async () => {
  const request = new URL(youtubeRequestUrl('https://youtu.be/z164pDlYtOk', 'home'));
  assert.equal(request.origin, LOCAL_SERVER_URL);
  assert.equal(request.pathname, '/api/youtube');
  assert.equal(await checkLocalServer(async url => {
    assert.equal(url, `${LOCAL_SERVER_URL}/api/health`);
    return Response.json({ service: 'melody-tab', version: 1 });
  }), LOCAL_SERVER_URL);
  await assert.rejects(checkLocalServer(async () => { throw new Error('offline'); }), /start-youtube-helper.cmd/);
  await assert.rejects(checkLocalServer(async () => Response.json({ service: 'other' })), /เวอร์ชันล่าสุด/);
});

test('health check verifies the helper identity and reports missing, blocked and busy helpers', async () => {
  const valid = { service: 'melody-tab-youtube-helper', version: 1, busy: false };
  assert.deepEqual(await checkYouTubeHelper(async () => Response.json(valid)), valid);
  await assert.rejects(checkYouTubeHelper(async () => { throw new TypeError('Failed to fetch'); }), /start-youtube-helper.cmd/);
  await assert.rejects(checkYouTubeHelper(async () => new Response('forbidden', { status: 403 })), /ไม่อนุญาต/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ service: 'unrelated' })), /ไม่ใช่เวอร์ชัน/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ ...valid, busy: true })), /แท็บอื่น/);
});
