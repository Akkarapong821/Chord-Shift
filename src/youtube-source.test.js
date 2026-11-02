import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultYouTubeSource, youtubeRequestUrl, checkYouTubeHelper } from './youtube-source.js';

test('hosted pages use the helper while development keeps its local API', () => {
  assert.equal(defaultYouTubeSource('chord-shift.onrender.com'), 'helper');
  assert.equal(defaultYouTubeSource('127.0.0.1'), 'server');
  assert.equal(defaultYouTubeSource('localhost'), 'server');
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
