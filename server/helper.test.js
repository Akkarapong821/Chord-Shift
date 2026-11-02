import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHelperServer, HELPER_SERVICE } from './helper.js';

const origin = 'https://chord-shift.onrender.com';
async function start(t, options = {}) {
  const server = createHelperServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the deployed site can discover the loopback helper', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/health`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await response.json(), { service: HELPER_SERVICE, version: 1, busy: false });
});

test('rejects foreign origins, opaque origins, cross-site images and DNS-rebinding hosts before download', async (t) => {
  let called = false;
  const base = await start(t, { youtubeHandler: (_req, res) => { called = true; res.end('unexpected'); } });
  for (const headers of [
    { Origin: 'https://evil.example' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: origin, Host: 'evil.example' },
  ]) {
    // Node fetch rewrites Host; use raw HTTP to exercise DNS-rebinding input.
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/youtube?url=test`, { headers }, (res) => {
        res.resume(); resolve(res);
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.statusCode, 403, JSON.stringify(headers));
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(called, false);
});

test('allows private-network preflight only for the authorized site', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/api/youtube`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET');
  assert.equal((await fetch(`${base}/health`, { method: 'OPTIONS', headers: {
    Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET',
  } })).status, 403);
});

test('returns audio and exposes Thai title for the cross-origin browser', async (t) => {
  const base = await start(t, { youtubeHandler: async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mp4', 'X-Video-Title': encodeURIComponent('เพลงทดสอบ') });
    res.end('audio');
  } });
  const response = await fetch(`${base}/api/youtube?url=test`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('access-control-expose-headers'), /X-Video-Title/);
  assert.equal(decodeURIComponent(response.headers.get('x-video-title')), 'เพลงทดสอบ');
  assert.equal(await response.text(), 'audio');
});

test('handles unknown routes, methods and concurrent requests without spawning extra downloads', async (t) => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const base = await start(t, { youtubeHandler: async (_req, res) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    res.end('audio');
  } });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
  const first = fetch(`${base}/api/youtube?url=test`, { headers: { Origin: origin } });
  await started;
  const second = await fetch(`${base}/api/youtube?url=test`, { headers: { Origin: origin } });
  assert.equal(second.status, 503);
  assert.equal(await second.text(), 'helper-busy');
  assert.equal((await (await fetch(`${base}/health`)).json()).busy, true);
  release();
  assert.equal(await (await first).text(), 'audio');
  assert.equal((await (await fetch(`${base}/health`)).json()).busy, false);
});
