import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAppServer } from './index.js';

async function withServer(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves the app and built assets from the same origin', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'melody-tab-dist-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await mkdir(join(distDir, 'assets'));
  await writeFile(join(distDir, 'index.html'), '<h1>Chord Shift</h1>');
  await writeFile(join(distDir, 'assets', 'app.js'), 'export {};');
  const base = await withServer(t, createAppServer({ distDir }));
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { service: 'melody-tab', version: 1 });

  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(await home.text(), '<h1>Chord Shift</h1>');

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(await asset.text(), 'export {};');
});

test('routes YouTube requests to the API handler instead of static 404', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'melody-tab-dist-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  const youtubeHandler = (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid-url');
  };
  const base = await withServer(t, createAppServer({ distDir, youtubeHandler }));

  const response = await fetch(`${base}/api/youtube?url=invalid`);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'invalid-url');
});

test('GitHub Pages can connect to the home API, including private-network preflight', async (t) => {
  const base = await withServer(t, createAppServer({ youtubeHandler: (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Audio-Start': '0', 'X-Audio-Full-Song': '1' }); res.end('guitar');
  } }));
  const origin = 'https://akkarapong821.github.io';
  const health = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), origin);
  const audio = await fetch(`${base}/api/youtube?url=test`, { headers: { Origin: origin } });
  assert.match(audio.headers.get('access-control-expose-headers'), /X-Audio-Full-Song/);
  assert.match(audio.headers.get('access-control-expose-headers'), /X-Audio-Stems/);
  assert.equal(await audio.text(), 'guitar');
  const preflight = await fetch(`${base}/api/youtube`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const foreign = await fetch(`${base}/api/youtube?url=test`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
});

test('rejects unsupported methods and paths outside the built site', async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), 'melody-tab-dist-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, 'index.html'), 'home');
  const base = await withServer(t, createAppServer({ distDir }));

  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 403);
});
