import { Innertube } from 'youtubei.js';
import { downloadAudio, MAX_AUDIO_BYTES } from './youtube-download.js';
import { guitarRange, separateGuitar } from './guitar-separation.js';

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

export function createYouTubeHandler({ getInnertube, download = downloadAudio, separate = separateGuitar, timeoutMs = 60000 } = {}) {
  let session;
  getInnertube ??= () => (session ??= Innertube.create().catch((error) => {
    session = null;
    throw error;
  }));

  return async (req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const videoId = extractVideoId(params.get('url'));
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('invalid-url');
      return;
    }
    const guitar = params.get('isolate') === 'guitar';
    let range;
    try { if (guitar) range = guitarRange(params); }
    catch (error) { res.writeHead(error.status, { 'Content-Type': 'text/plain' }); res.end(error.code); return; }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    let timeout = setTimeout(cancel, timeoutMs);
    try {
      let info = null;
      try {
        const yt = await abortable(getInnertube(), controller.signal);
        info = await abortable(yt.getBasicInfo(videoId, { client: YT_CLIENT }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.warn('[youtube] metadata-unavailable');
      }
      if (controller.signal.aborted) throw fail('download-timeout', 504);
      if (Number(info?.basic_info?.duration) > MAX_VIDEO_SECONDS) throw fail('video-too-long', 413);
      if (info?.basic_info?.is_live) throw fail('live-video', 400);

      // Wait for the downloader to finish before committing audio headers.
      // A failed or partial transfer must remain a readable HTTP error.
      let audio;
      try {
        audio = await abortable(download(videoId, controller.signal), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (!error.code && info?.playability_status?.status && info.playability_status.status !== 'OK') {
          throw fail('video-unavailable');
        }
        throw error;
      }
      if (controller.signal.aborted) throw fail('download-timeout', 504);
      if (!audio.length) throw fail('incomplete-audio');
      if (guitar) {
        if (!range.full && info?.basic_info?.duration && range.end > Number(info.basic_info.duration)) throw fail('guitar-range-invalid', 422);
        clearTimeout(timeout);
        timeout = setTimeout(cancel, (range.full ? 60 : 15) * 60 * 1000);
        audio = await abortable(separate(audio, range, controller.signal), controller.signal);
        res.setHeader('X-Audio-Start', String(range.start));
        res.setHeader('X-Audio-Isolation', 'guitar');
        if (range.stems) res.setHeader('X-Audio-Stems', range.stems.join(','));
        if (range.full) res.setHeader('X-Audio-Full-Song', '1');
      }
      if (audio.length > (guitar ? (range.stems ? 96 : 64) * 1024 * 1024 : MAX_AUDIO_BYTES)) throw fail('audio-too-large', 413);
      res.writeHead(200, {
        'Content-Type': guitar ? 'audio/wav' : 'audio/mp4',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
        'X-Video-Title': encodeURIComponent(info?.basic_info?.title || videoId),
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
