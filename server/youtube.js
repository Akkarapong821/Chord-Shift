import { Innertube } from 'youtubei.js';
import { downloadAudio, MAX_AUDIO_BYTES } from './youtube-download.js';

const MAX_VIDEO_SECONDS = 15 * 60;
const YT_CLIENT = 'IOS';

export function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) return null;
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      return u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/)?.[1] || null;
    }
  } catch { /* Invalid URL. */ }
  return null;
}

function fail(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}

async function abortable(promise, signal) {
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(fail('download-timeout', 504));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function createYouTubeHandler({ getInnertube, download = downloadAudio, timeoutMs = 60000 } = {}) {
  let session;
  getInnertube ??= () => (session ??= Innertube.create().catch((error) => {
    session = null;
    throw error;
  }));

  return async (req, res) => {
    const videoId = extractVideoId(new URL(req.url, 'http://localhost').searchParams.get('url'));
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('invalid-url');
      return;
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    const timeout = setTimeout(cancel, timeoutMs);
    try {
      const yt = await abortable(getInnertube(), controller.signal);
      const info = await abortable(yt.getBasicInfo(videoId, { client: YT_CLIENT }), controller.signal);
      if (controller.signal.aborted) throw fail('download-timeout', 504);
      if (Number(info.basic_info.duration) > MAX_VIDEO_SECONDS) throw fail('video-too-long', 413);
      if (info.basic_info.is_live) throw fail('live-video', 400);
      if (info.playability_status?.status !== 'OK') throw fail('video-unavailable');

      // Wait for the downloader to finish before committing audio headers.
      // A failed or partial transfer must remain a readable HTTP error.
      const audio = await abortable(download(videoId, controller.signal), controller.signal);
      if (controller.signal.aborted) throw fail('download-timeout', 504);
      if (!audio.length) throw fail('incomplete-audio');
      if (audio.length > MAX_AUDIO_BYTES) throw fail('audio-too-large', 413);
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
        'X-Video-Title': encodeURIComponent(info.basic_info.title || 'youtube'),
      });
      res.end(audio);
    } catch (error) {
      if (!res.destroyed) {
        const code = controller.signal.aborted ? 'download-timeout' : error.code || 'fetch-failed';
        const status = controller.signal.aborted ? 504 : error.status || 502;
        console.error('[youtube]', code);
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(code);
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', cancel);
      controller.abort();
    }
  };
}

export function youtubeAudioPlugin() {
  const handler = createYouTubeHandler();
  return {
    name: 'youtube-audio',
    configureServer(server) { server.middlewares.use('/api/youtube', handler); },
    configurePreviewServer(server) { server.middlewares.use('/api/youtube', handler); },
  };
}
