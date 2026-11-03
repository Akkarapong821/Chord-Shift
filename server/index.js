import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYouTubeHandler } from './youtube.js';

const defaultDistDir = fileURLToPath(new URL('../dist/', import.meta.url));
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
};

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

export function createAppServer({ distDir = defaultDistDir, youtubeHandler = createYouTubeHandler(), allowedOrigins = [
  'https://akkarapong821.github.io', 'https://chord-shift.onrender.com',
  'http://127.0.0.1:5173', 'http://localhost:5173',
] } = {}) {
  const root = resolve(distDir);
  return createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'bad-request');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if ((origin && !allowedOrigins.includes(origin)) || (!origin && req.headers['sec-fetch-site'] === 'cross-site')) {
        sendText(res, 403, 'forbidden-origin'); return;
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'X-Video-Title, X-Audio-Start, X-Audio-Isolation, X-Audio-Full-Song, X-Audio-Stems, Content-Length');
      }
      if (req.method === 'OPTIONS') {
        if (!origin || req.headers['access-control-request-method'] !== 'GET') { sendText(res, 403, 'forbidden-preflight'); return; }
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204); res.end(); return;
      }
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ service: 'melody-tab', version: 1 }));
      return;
    }

    if (pathname === '/api/youtube') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendText(res, 405, 'method-not-allowed');
        return;
      }
      youtubeHandler(req, res);
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'method-not-allowed');
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = resolve(root, relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath);
    const fileRelative = relative(root, filePath);
    if (fileRelative.startsWith('..') || isAbsolute(fileRelative)) {
      sendText(res, 403, 'forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      sendText(res, 404, 'not-found');
      return;
    }

    const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': statSync(filePath).size,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath).pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Melody Tab listening on port ${port}`));
}
