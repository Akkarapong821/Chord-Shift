import { defineConfig } from 'vite';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Innertube } from 'youtubei.js';

const MAX_VIDEO_SECONDS = 15 * 60;

// The iOS InnerTube client returns direct (non-ciphered) stream URLs, which
// sidesteps YouTube's player-script deciphering that regularly breaks
// extractor libraries. Verified working via scripts/test-youtube.mjs — run
// that first if YouTube fetching ever stops working.
const YT_CLIENT = 'IOS';

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Serves audio-only streams from YouTube at /api/youtube?url=... so the
// browser (which can't reach YouTube directly due to CORS) can transcribe
// them. Audio-only formats (m4a/webm-opus) decode natively in the browser,
// so no ffmpeg is needed.
function youtubeAudioPlugin() {
  let innertubePromise = null;
  const getInnertube = () => (innertubePromise ??= Innertube.create());

  const handler = async (req, res) => {
    const videoUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
    const videoId = videoUrl && extractVideoId(videoUrl);
    if (!videoId) {
      res.statusCode = 400;
      res.end('invalid-url');
      return;
    }
    try {
      const yt = await getInnertube();
      const info = await yt.getBasicInfo(videoId, { client: YT_CLIENT });
      if (Number(info.basic_info.duration) > MAX_VIDEO_SECONDS) {
        res.statusCode = 413;
        res.end('video-too-long');
        return;
      }
      const options = { type: 'audio', quality: 'best', client: YT_CLIENT };
      const format = info.chooseFormat(options);
      res.setHeader('Content-Type', format.mime_type?.split(';')[0] || 'audio/mp4');
      if (format.content_length) res.setHeader('Content-Length', String(format.content_length));
      res.setHeader('X-Video-Title', encodeURIComponent(info.basic_info.title || 'youtube'));

      const webStream = await info.download(options);
      const stream = Readable.fromWeb(webStream);
      stream.on('error', (err) => {
        console.error('[youtube] stream error:', err.message);
        res.destroy(err);
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[youtube] fetch failed:', err.message);
      res.statusCode = 500;
      res.end('fetch-failed');
    }
  };
  return {
    name: 'youtube-audio',
    configureServer(server) {
      server.middlewares.use('/api/youtube', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/youtube', handler);
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      // Two independent pages: Melody Tab and Chord Shift.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        chords: fileURLToPath(new URL('./chords.html', import.meta.url)),
      },
    },
  },
  plugins: [youtubeAudioPlugin()],
});
