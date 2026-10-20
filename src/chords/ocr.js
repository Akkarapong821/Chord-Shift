// Read the chord names off a chord-sheet image, entirely in the browser.
//
// Pipeline (tuned on real Thai chord sheets, see detect.test.js):
//   1. Upscale to ~2000px wide and binarise (global Otsu AND a local-mean
//      check). Light watermarks fall above the threshold and vanish; uneven
//      lighting in phone photos doesn't turn paper black.
//   2. Tesseract (English, LSTM) in sparse-text mode reads every word on its
//      own, so a chord can't be swallowed into the Thai lyric line below it.
//   3. detect.js keeps the words that are chords; borderline ones (bar
//      sequences like '/D/D/G/Gm/') are re-read box by box with a chord-only
//      character whitelist.
// The engine and language data are served from public/tesseract (copied by
// scripts/copy-tesseract.mjs), so nothing leaves the device.

import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  classifyWords, findColumns, inkBoxNear, isBarSequence, medianBlobHeight, medianHeight, mergeDetections, overlapsAny,
  parseChordText, sortReadingOrder, tightenBox, toItem, wordBox,
} from './detect.js';

const TARGET_WIDTH = 2000;
const MAX_WORK_PIXELS = 16e6; // stay under mobile canvas limits
const MAX_SOURCE_SIDE = 3200; // keep the displayed original reasonably sized
const WHITELIST = 'ABCDEFGmajdisuob#0123456789/+()-|';

let workerPromise = null;
let progressHandler = null;

function assetUrl(path) {
  return new URL(`tesseract/${path}`, document.baseURI).href;
}

function getWorker() {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: assetUrl('worker.min.js'),
    corePath: assetUrl(''),
    langPath: assetUrl('lang'),
    gzip: true,
    logger: (m) => progressHandler?.(m),
  }).catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

// Stop any OCR in flight (used by the cancel button). The next read starts a
// fresh worker.
export async function cancelOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (p) {
    try {
      (await p).terminate();
    } catch {
      /* already gone */
    }
  }
}

// --- Image loading -----------------------------------------------------------

// File/Blob -> canvas with the (possibly downscaled) original image.
export async function loadImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('unsupported-image'));
      };
      img.src = url;
    });
  }
  const w0 = bitmap.width;
  const h0 = bitmap.height;
  if (!w0 || !h0) throw new Error('unsupported-image');
  const k = Math.min(1, MAX_SOURCE_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * k);
  canvas.height = Math.round(h0 * k);
  // Colours are sampled from this canvas later (render.js sampleColors).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // White under transparent PNGs.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

// --- Binarisation --------------------------------------------------------------

function otsu(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

// Largest scale the canvas budget allows for this source.
function maxScale(source) {
  return Math.min(4, Math.sqrt(MAX_WORK_PIXELS / (source.width * source.height)));
}

// Scaled black-and-white copy of the page for OCR (always dark text on
// white: light-on-dark pages are inverted first).
// -> { canvas, thin, ink: Uint8Array (1 = text), width, height, scale, inverted }
export function binarize(source, wantedScale) {
  let scale = wantedScale ?? Math.min(3, Math.max(0.5, TARGET_WIDTH / source.width));
  scale = Math.min(scale, maxScale(source));
  const W = Math.round(source.width * scale);
  const H = Math.round(source.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  const N = W * H;
  const gray = new Uint8Array(N);
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    hist[gray[i]]++;
  }
  // Dark-mode sheets (light or coloured text on black): if most of the page
  // is dark, flip it so the text becomes the dark part.
  let below = 0;
  let median = 0;
  while (median < 255 && (below += hist[median]) < N / 2) median++;
  const inverted = median < 110;
  if (inverted) {
    hist.reverse();
    for (let i = 0; i < N; i++) gray[i] = 255 - gray[i];
  }
  const global = otsu(hist, N);

  // Integral image for local means.
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + row;
    }
  }
  // Two versions: the normal threshold, and a stricter one whose thinner
  // strokes keep upscaled low-res letters from merging into blobs. OCR passes
  // on each miss different chords (measured on downscaled sample sheets).
  const thinGlobal = global * 0.8;
  const thinImg = ctx.createImageData(W, H);
  const t = thinImg.data;
  const r = Math.max(10, Math.round(Math.min(W, H) / 50));
  const ink = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(W, x + r + 1);
      const area = (xb - xa) * (yb - ya);
      const s = integral[yb * (W + 1) + xb] - integral[ya * (W + 1) + xb] - integral[yb * (W + 1) + xa] + integral[ya * (W + 1) + xa];
      const v = gray[y * W + x];
      const local = v < s / area - 8;
      const dark = local && v < global;
      const darkThin = local && v < thinGlobal;
      ink[y * W + x] = dark ? 1 : 0;
      const o = (y * W + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = dark ? 0 : 255;
      t[o] = t[o + 1] = t[o + 2] = darkThin ? 0 : 255;
      d[o + 3] = t[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const thin = document.createElement('canvas');
  thin.width = W;
  thin.height = H;
  thin.getContext('2d').putImageData(thinImg, 0, 0);
  return { canvas, thin, ink, width: W, height: H, scale, inverted };
}

// Scale that brings the page's letters to LETTER_PX tall: measure the median
// ink-blob height on a quick unscaled binarisation first.
const LETTER_PX = 28;
function autoScale(source) {
  const probe = binarize(source, Math.min(1, TARGET_WIDTH / source.width));
  const blobH = medianBlobHeight(probe.ink, probe.width, probe.height);
  if (!blobH) return undefined; // no text found: fall back to width-based
  return Math.min(4, Math.max(0.5, LETTER_PX / (blobH / probe.scale)));
}

function cropCanvas(bin, box, pad = 10) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w + pad * 2));
  c.height = Math.max(1, Math.round(box.h + pad * 2));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bin.canvas, box.x, box.y, box.w, box.h, pad, pad, box.w, box.h);
  return c;
}

// --- Recognition -------------------------------------------------------------

const STATUS_TH = {
  'loading tesseract core': 'กำลังเตรียมตัวอ่านคอร์ด…',
  'initializing tesseract': 'กำลังเตรียมตัวอ่านคอร์ด…',
  'loading language traineddata': 'กำลังโหลดข้อมูลตัวอักษร…',
  'initializing api': 'กำลังเตรียมตัวอ่านคอร์ด…',
  'recognizing text': 'กำลังหาคอร์ดในรูป…',
};

function wordsOf(data, scale) {
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          out.push({
            text: w.text,
            confidence: w.confidence,
            bbox: { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale },
          });
        }
      }
    }
  }
  return out;
}

async function readWhitelisted(worker, bin, box) {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: WHITELIST });
  const { data } = await worker.recognize(cropCanvas(bin, box));
  return data.text.replace(/\s+/g, '').trim();
}

// Canvas of one page -> { items, meta, bin }. Item coordinates are in the
// page canvas' pixels. onStatus(textTh, fraction 0..1).
export async function readChords(source, { onStatus, scale } = {}) {
  let pass = 0;
  progressHandler = (m) => {
    const label = STATUS_TH[m.status];
    if (label && onStatus) onStatus(label, m.status === 'recognizing text' ? (pass + m.progress) * 0.42 : 0);
  };
  try {
    const worker = await getWorker();
    onStatus?.('กำลังปรับภาพให้อ่านง่าย…', 0);
    const bin = binarize(source, scale ?? autoScale(source));

    // Sparse mode on thin strokes keeps chords apart from the lyrics; automatic
    // layout on the normal image catches what that misses. Keep the union.
    const passes = [];
    for (const [i, [mode, image]] of [[PSM.SPARSE_TEXT, bin.thin], [PSM.AUTO, bin.canvas]].entries()) {
      pass = i;
      await worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: '' });
      const { data } = await worker.recognize(image, {}, { blocks: true });
      passes.push(classifyWords(wordsOf(data, bin.scale)));
    }
    bin.thin = null; // only needed for the first pass
    const { items, recheck, meta } = mergeDetections(passes);

    // Second look at borderline words with a chord-only alphabet.
    for (let i = 0; i < recheck.length; i++) {
      onStatus?.('กำลังตรวจคอร์ดที่ไม่ชัด…', 0.85 + (0.15 * i) / recheck.length);
      const w = recheck[i];
      if (overlapsAny(items, wordBox(w))) continue; // already read as part of a wider box
      const s = bin.scale;
      const box = { x: w.bbox.x0 * s, y: w.bbox.y0 * s, w: (w.bbox.x1 - w.bbox.x0) * s, h: (w.bbox.y1 - w.bbox.y0) * s };
      const text = await readWhitelisted(worker, bin, box);
      // The first read of a bar line is often right but low-confidence; a
      // multi-chord '/D/G/Am/' pattern is too specific to be lyric garbage.
      const first = parseChordText(w.text);
      const parsed = parseChordText(text) || (isBarSequence(first, w.text) ? first : null);
      if (parsed) items.push(toItem({ ...w, confidence: 60 }, parsed.tokens));
    }
    // Boxes much taller than a typical chord took in lyric marks: shrink them.
    const typical = medianHeight(items, 0);
    const s = bin.scale;
    for (const it of items) {
      if (!typical || it.h <= typical * 1.25) continue;
      const t = tightenBox(bin.ink, bin.width, bin.height, { x: it.x * s, y: it.y * s, w: it.w * s, h: it.h * s });
      if (t.h / s >= typical * 0.6) Object.assign(it, { x: t.x / s, y: t.y / s, w: t.w / s, h: t.h / s });
    }
    return { items: sortReadingOrder(items), meta, bin };
  } finally {
    progressHandler = null;
  }
}

// Side-by-side columns on the page (page pixels), [] for a single column.
export function detectColumns(source) {
  const probe = binarize(source, Math.min(1, TARGET_WIDTH / source.width));
  const k = probe.scale;
  return findColumns(probe.ink, probe.width, probe.height).map((c) => ({
    x: Math.floor(c.x / k),
    y: Math.floor(c.y / k),
    w: Math.min(source.width, Math.ceil(c.w / k)),
    h: Math.min(source.height, Math.ceil(c.h / k)),
  }));
}

// A tap at (x, y) in page pixels where a chord was missed -> a new item
// (text may be '' if it couldn't be read; the user types it).
export async function readChordAt(page, x, y) {
  page.bin ??= binarize(page.source, autoScale(page.source));
  const bin = page.bin;
  const s = bin.scale;
  const letterH = medianHeight(page.items, page.source.height / 60) * s;
  const box = inkBoxNear(bin.ink, bin.width, bin.height, x * s, y * s, letterH);
  if (!box) return null;
  const worker = await getWorker();
  const text = await readWhitelisted(worker, bin, box);
  const parsed = parseChordText(text);
  const word = { text, confidence: parsed ? 60 : 0, bbox: { x0: box.x / s, y0: box.y / s, x1: (box.x + box.w) / s, y1: (box.y + box.h) / s } };
  return toItem(word, parsed ? parsed.tokens : []);
}
