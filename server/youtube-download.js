import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const localBinary = fileURLToPath(new URL(`../.tools/yt-dlp${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

export function downloadAudio(videoId, signal, { spawnProcess = spawn } = {}) {
  const binary = process.env.YT_DLP_PATH || (existsSync(localBinary) ? localBinary : 'yt-dlp');
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    // Arguments are passed directly, never through a shell. Use only the
    // validated video ID, never user-provided yt-dlp flags or playlist URLs.
    const child = spawnProcess(binary, [
      '--ignore-config', '--no-playlist', '--no-progress', '--no-cache-dir',
      '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '15',
      '--retries', '1', '--fragment-retries', '1', '--abort-on-unavailable-fragments',
      '--max-filesize', String(MAX_AUDIO_BYTES), '-f', 'bestaudio[ext=m4a]',
      '-o', '-', '--', `https://www.youtube.com/watch?v=${videoId}`,
    ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let received = 0;
    let errorText = '';
    let failure;
    const abort = () => { failure ??= new Error('Aborted'); child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_AUDIO_BYTES) {
        failure = Object.assign(new Error('audio-too-large'), { code: 'audio-too-large', status: 413 });
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk.toString()).slice(-8000); });
    child.on('error', (error) => {
      failure = Object.assign(error, { code: error.code === 'ENOENT' ? 'downloader-missing' : 'fetch-failed', status: 503 });
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0 || !received) {
        const errorCode = /larger than max-filesize/i.test(errorText) ? 'audio-too-large'
          : /403|Forbidden/i.test(errorText) ? 'upstream-forbidden' : 'fetch-failed';
        reject(Object.assign(new Error(errorCode), { code: errorCode, status: errorCode === 'audio-too-large' ? 413 : 502 }));
        return;
      }
      const audio = Buffer.concat(chunks, received);
      if (audio.length < 12 || audio.toString('ascii', 4, 8) !== 'ftyp') {
        reject(Object.assign(new Error('invalid-audio'), { code: 'invalid-audio', status: 502 }));
        return;
      }
      resolve(audio);
    });
  });
}
