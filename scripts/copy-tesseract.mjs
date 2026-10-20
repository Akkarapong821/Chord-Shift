// Copy the Tesseract OCR engine (wasm) and English language data out of
// node_modules so Chord Shift can read chord sheets fully offline — nothing is
// fetched from a CDN at runtime.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const dest = join(root, 'public', 'tesseract');

const worker = join(modules, 'tesseract.js', 'dist', 'worker.min.js');
const coreDir = join(modules, 'tesseract.js-core');
// LSTM-only "best_int" model: same accuracy on chord names as the full model at ~1/4 the size.
const lang = join(modules, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz');

for (const p of [worker, coreDir, lang]) {
  if (!existsSync(p)) {
    console.error('tesseract file not found at', p);
    process.exit(1);
  }
}

mkdirSync(join(dest, 'lang'), { recursive: true });
cpSync(worker, join(dest, 'worker.min.js'));
// tesseract.js picks the simd / relaxed-simd / plain build at runtime; ship all LSTM variants.
for (const f of readdirSync(coreDir)) {
  if (/^tesseract-core.*-lstm\.(js|wasm|wasm\.js)$/.test(f)) cpSync(join(coreDir, f), join(dest, f));
}
cpSync(lang, join(dest, 'lang', 'eng.traineddata.gz'));
console.log('Copied Tesseract OCR engine + English data to public/tesseract');
