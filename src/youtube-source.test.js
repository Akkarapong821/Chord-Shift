import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultYouTubeSource, youtubeRequestUrl, checkYouTubeHelper, youtubePreviewUrl, normalizeHomeServer, checkHomeServer } from './youtube-source.js';

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

test('desktop server URLs accept only this computer and reject retired phone links', async () => {
  const home = 'http://127.0.0.1:39842';
  assert.equal(normalizeHomeServer(`${home}/index.html?page=melody`), home);
  assert.equal(normalizeHomeServer(`https://akkarapong821.github.io/Chord-Shift/index.html?page=melody&home=${encodeURIComponent(home)}`), home);
  assert.equal(normalizeHomeServer('http://localhost:39842/'), 'http://localhost:39842');
  assert.equal(normalizeHomeServer('http://[::1]:39842/'), 'http://[::1]:39842');
  for (const value of ['https://home.example.ts.net:8443', 'http://192.168.1.20:39842', 'https://127.0.0.1.evil.test', 'http://user:pass@localhost:39842', 'javascript:alert(1)', '']) {
    assert.throws(() => normalizeHomeServer(value));
  }
  const request = new URL(youtubeRequestUrl('https://youtu.be/z164pDlYtOk', 'home', home));
  assert.equal(request.origin, home);
  assert.equal(request.pathname, '/api/youtube');
  assert.equal(await checkHomeServer(home, async () => Response.json({ service: 'melody-tab', version: 1 })), home);
  await assert.rejects(checkHomeServer(home, async () => { throw new Error('offline'); }), /Server ON/);
  await assert.rejects(checkHomeServer(home, async () => Response.json({ service: 'other' })), /เวอร์ชันล่าสุด/);
});

test('health check verifies the helper identity and reports missing, blocked and busy helpers', async () => {
  const valid = { service: 'melody-tab-youtube-helper', version: 1, busy: false };
  assert.deepEqual(await checkYouTubeHelper(async () => Response.json(valid)), valid);
  await assert.rejects(checkYouTubeHelper(async () => { throw new TypeError('Failed to fetch'); }), /start-youtube-helper.cmd/);
  await assert.rejects(checkYouTubeHelper(async () => new Response('forbidden', { status: 403 })), /ไม่อนุญาต/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ service: 'unrelated' })), /ไม่ใช่เวอร์ชัน/);
  await assert.rejects(checkYouTubeHelper(async () => Response.json({ ...valid, busy: true })), /แท็บอื่น/);
});
