import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultYouTubeSource, youtubeRequestUrl, checkYouTubeHelper, youtubePreviewUrl } from './youtube-source.js';

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

test('hosted pages use the helper while development keeps its local API', () => {
  assert.equal(defaultYouTubeSource('chord-shift.onrender.com'), 'helper');
  assert.equal(defaultYouTubeSource('127.0.0.1'), 'server');
  assert.equal(defaultYouTubeSource('localhost'), 'server');
  assert.equal(defaultYouTubeSource('home.example.ts.net'), 'server');
  const video = 'https://youtube.com/watch?v=z164pDlYtOk&list=test';
  const url = new URL(youtubeRequestUrl(video, 'helper'));
  assert.equal(url.origin, 'http://127.0.0.1:39841');
  assert.equal(url.searchParams.get('url'), video);
  assert.ok(youtubeRequestUrl(video, 'server').startsWith('/api/youtube?'));
});

test('health check verifies the helper identity and reports missing, blocked and busy helpers', async () => {
  const valid = { service: 'melody-tab-youtube-helper', version: 1, busy: false };
  assert.deepEqual(await checkYouTubeHelper(async () => Response.json(valid)), valid);
  await assert.rejects(checkYouTubeHelper(async () => { throw new TypeError('Failed to fetch'); }), /start-youtube-helper.cmd/);
  await assert.rejects(checkYouTubeHelper(async () => new Response('forbidden', { status: 403 })), /ไม่อนุญาต/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ service: 'unrelated' })), /ไม่ใช่เวอร์ชัน/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ ...valid, busy: true })), /แท็บอื่น/);
});
