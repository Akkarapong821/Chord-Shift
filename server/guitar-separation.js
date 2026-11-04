import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const guitarPython = join(root, '.tools/guitar-env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let active = false;
const fail = (code, status = 422) => Object.assign(new Error(code), { code, status });

export function guitarRange(params) {
  const stems = params.get('stems');
  if (stems !== null && stems !== 'guitar,drums' && stems !== 'guitar,drums,original') throw fail('guitar-stems-invalid');
  const options = stems ? { stems: stems.split(',') } : {};
  if (params.get('full') === '1') return { start: 0, end: null, full: true, ...options };
  const start = Number(params.get('start') || 0);
  const endText = params.get('end');
  const end = Number(endText);
  if (!endText || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 900 || end - start < 0.1 || end - start > 60) {
    throw fail('guitar-range-invalid');
  }
  return { start, end, ...options };
}

export async function separateGuitar(audio, range, signal) {
  if (!existsSync(guitarPython)) throw fail('guitar-not-installed', 503);
  if (active) throw fail('guitar-busy', 503);
  active = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'melody-guitar-'));
    const input = join(directory, 'input.m4a');
    const output = join(directory, 'guitar.wav');
    await writeFile(input, audio);
    if (signal.aborted) throw fail('guitar-cancelled');
    await new Promise((resolve, reject) => {
      const selectionArgs = range.full ? ['--full'] : ['--start', String(range.start), '--end', String(range.end)];
      if (range.stems) selectionArgs.push('--stems', range.stems.join(','));
      const child = spawn(guitarPython, [join(root, 'scripts/separate-guitar.py'), '--input', input,
        '--output', output, ...selectionArgs], {
        windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let detail = '';
      const abort = () => child.kill();
      signal.addEventListener('abort', abort, { once: true });
      child.stderr.on('data', data => { detail = (detail + data.toString()).slice(-2000); });
      child.on('error', () => { signal.removeEventListener('abort', abort); reject(fail('guitar-failed', 500)); });
      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(fail('guitar-cancelled'));
        else if (code !== 0) {
          console.error('[guitar]', detail.replace(/https?:\/\/\S+/g, '[url]'));
          reject(fail('guitar-failed', 500));
        } else resolve();
      });
    });
    const wav = await readFile(output);
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw fail('guitar-failed', 500);
    return wav;
  } finally {
    try { if (directory) {
      // Only remove the exact, freshly created job directory within TEMP.
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('melody-guitar-')) {
        await rm(directory, { recursive: true, force: true });
      }
    } } finally { active = false; }
  }
}
