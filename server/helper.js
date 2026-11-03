import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYouTubeHandler } from './youtube.js';

export const HELPER_PORT = 39841;
export const HELPER_SERVICE = 'melody-tab-youtube-helper';
const defaultOrigins = [
  'https://chord-shift.onrender.com',
  'http://127.0.0.1:5173', 'http://localhost:5173',
  'http://127.0.0.1:4173', 'http://localhost:4173',
];

export function createHelperServer({ allowedOrigins = defaultOrigins, youtubeHandler = createYouTubeHandler() } = {}) {
  const origins = new Set(allowedOrigins);
  let downloading = false;
  return createServer(async (req, res) => {
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
    };
    // Bind only to loopback and reject DNS-rebinding hosts before any work.
    const port = req.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      send(403, 'forbidden-host'); return;
    }
    const origin = req.headers.origin;
    if ((origin && !origins.has(origin)) || (!origin && req.headers['sec-fetch-site'] === 'cross-site')) {
      send(403, 'forbidden-origin'); return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Video-Title, Content-Length, X-Audio-Start, X-Audio-Isolation');
    }
    if (req.method === 'OPTIONS') {
      if (!origin || req.headers['access-control-request-method'] !== 'GET') {
        send(403, 'forbidden-preflight'); return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      // Older Chromium uses Private Network Access preflights. Newer browsers
      // may additionally ask the user for local-network permission.
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'GET') { send(405, 'method-not-allowed'); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ service: HELPER_SERVICE, version: 1, busy: downloading }));
      return;
    }
    if (path !== '/api/youtube') { send(404, 'not-found'); return; }
    if (downloading) { send(503, 'helper-busy'); return; }
    downloading = true;
    try { await youtubeHandler(req, res); }
    catch { if (!res.headersSent && !res.destroyed) send(500, 'fetch-failed'); }
    finally { downloading = false; }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createHelperServer();
  server.on('error', (error) => {
    console.error(`Cannot start YouTube helper: ${error.code}`);
    process.exitCode = 1;
  });
  server.listen(HELPER_PORT, '127.0.0.1', () => {
    console.log(`YouTube helper ready at http://127.0.0.1:${HELPER_PORT}`);
    console.log('Keep this running while using YouTube on chord-shift.onrender.com.');
  });
}
